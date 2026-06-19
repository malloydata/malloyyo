// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT
//
// Integration test for the HOSTED explore surface (src/lib/mcp-host.ts), the
// engine-based /mcp. Exercises the real seam — buildHostedExploreSurface(...).call()
// — against a real Postgres (the metadata DB) with a seeded user + dataset +
// model. The model runs on in-process DuckDB, so Postgres is the only external
// dep. No HTTP, no OAuth, no ingest pipeline: this isolates the host logic the
// route is a thin wrapper over.
//
// Addressing is SOURCE-centric: list_sources lists sources; describe_source and
// query resolve a bare source against the catalog (model_ref optional).
//
// Run via `npm run test:hosted` (scripts/hosted-test.sh stands up Postgres,
// pushes the schema, and runs this with DATABASE_URL pointed at it).

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { desc, eq } from "drizzle-orm";
import { db, users, datasets, malloyModels, malloyModelFiles, queries, toolCalls, type User } from "@/db";
import { buildHostedExploreSurface } from "@/lib/mcp-host";

const MODEL = `#" Pet shop sales.
source: sales is duckdb.sql("""
  SELECT 'dog' as animal, 'CA' as state, 2 as qty
  UNION ALL SELECT 'cat', 'CA', 3
  UNION ALL SELECT 'dog', 'OR', 1
""") extend {
  measure: total_qty is qty.sum()
  #" Units sold per animal.
  view: by_animal is { group_by: animal; aggregate: total_qty }
}
`;

let user: User;

before(async () => {
  // Fresh container ⇒ empty schema. Seed one user + a READY dataset + a model.
  const [u] = await db.insert(users).values({ email: "fox@test.local", slug: "fox" }).returning();
  user = u;
  const [ds] = await db
    .insert(datasets)
    .values({ userId: u.id, name: "petshop", status: "ready", isPublic: false })
    .returning();
  await db.insert(malloyModels).values({
    datasetId: ds.id,
    version: 1,
    source: MODEL,
    generatedBy: "test",
    compiledAt: new Date(),
    sources: [{ name: "sales", description: "Pet shop sales." }],
  });

  // A MULTI-FILE model: index.malloy imports child.malloy and re-exports its
  // source. Exercises modelFileMap from real malloyModelFiles rows (not the
  // single-file fallback), the multi-file runtime resolving the import, and
  // hostReadSource building a multi-key URL map — the paths the single-file
  // model never touches.
  const [ds2] = await db
    .insert(datasets)
    .values({ userId: u.id, name: "multimod", status: "ready", isPublic: false })
    .returning();
  const CHILD = `source: base is duckdb.sql("select 'dog' as animal, 2 as qty") extend {\n  measure: total is qty.sum()\n}\n`;
  const INDEX = `import "child.malloy"\n#" Animals, relabeled.\nsource: pets is base extend {\n  view: by_animal is { group_by: animal; aggregate: total }\n}\n`;
  const [m2] = await db
    .insert(malloyModels)
    .values({
      datasetId: ds2.id,
      version: 1,
      source: INDEX,
      generatedBy: "test",
      compiledAt: new Date(),
      sources: [{ name: "pets", description: null }],
    })
    .returning();
  await db.insert(malloyModelFiles).values([
    { modelId: m2.id, path: "index.malloy", content: INDEX },
    { modelId: m2.id, path: "child.malloy", content: CHILD },
  ]);
});

function host() {
  return buildHostedExploreSurface(user, "http://localhost:3000");
}
function blockText(r: { content: Array<{ text: string }> }, i: number): string {
  return r.content[i]?.text ?? "";
}

test("list_sources surfaces each model's sources with their annotations", async () => {
  const r = await host().call("list_sources", {});
  const data = JSON.parse(blockText(r, 0)) as {
    ok: boolean;
    models: Array<{ model_ref: string; sources?: Array<{ source_ref: string; description?: string }> }>;
  };
  assert.equal(data.ok, true);
  const entry = data.models.find((e) => e.model_ref === "petshop");
  assert.ok(entry, "petshop is listed");
  const sales = entry!.sources?.find((s) => s.source_ref === "sales");
  assert.ok(sales, "its `sales` source is listed");
  // Description comes from the model's #" annotation (compiled fresh), not the DB.
  assert.equal(sales!.description, "Pet shop sales.");
});

test("describe_source resolves a bare source: schema (block 1) + verbatim text (block 2)", async () => {
  const r = await host().call("describe_source", { source: "sales" });
  assert.equal(r.content.length, 2, "two content blocks: schema + source text");
  const schema = JSON.parse(blockText(r, 0)) as {
    ok: boolean;
    model_ref: string;
    sources: Record<string, { measures: Array<{ name: string }>; views: Array<{ name: string }> }>;
  };
  assert.equal(schema.ok, true);
  assert.equal(schema.model_ref, "petshop", "bare source resolved to its model");
  assert.ok(schema.sources.sales, "sales is described in block 1");
  assert.ok(!blockText(r, 0).includes('"body"'), "block 1 carries no raw source text");
  assert.match(blockText(r, 1), /^source: sales is/, "block 2 is verbatim, unescaped Malloy");
  assert.match(blockText(r, 1), /view: by_animal is \{/, "block 2 carries the view definition");
});

test("describe_source on an unknown source fails cleanly (no throw)", async () => {
  const r = await host().call("describe_source", { source: "nope" });
  const out = JSON.parse(blockText(r, 0)) as { ok: boolean; problems: Array<{ code: string }> };
  assert.equal(out.ok, false);
  assert.ok(out.problems.some((p) => p.code === "source-not-found"));
});

test("query execute:false validates; execute:true runs on DuckDB + records a share link", async () => {
  const v = await host().call("query", {
    source: "sales",
    malloy: "run: sales -> by_animal",
    execute: false,
  });
  assert.equal((JSON.parse(blockText(v, 0)) as { ok: boolean }).ok, true, "compiles");

  const run = await host().call("query", {
    source: "sales",
    malloy: "run: sales -> { aggregate: total_qty }",
    execute: true,
    question: "total units sold",
  });
  // execute:true is decorated: block 0 = the summary reminder, block 1 = the JSON.
  const payload = JSON.parse(blockText(run, 1)) as {
    rows: Array<{ total_qty: number }>;
    model_ref?: string;
    ltool_url?: string;
    sql?: unknown;
    host_only?: unknown;
  };
  assert.equal(payload.rows.length, 1, "one aggregate row");
  assert.equal(payload.rows[0]!.total_qty, 6, "DuckDB actually summed 2+3+1");
  assert.equal(payload.model_ref, "petshop", "result reports the resolved model");
  assert.ok(payload.ltool_url, "a share link was minted and recorded");
  // The agent must NOT see SQL on an executed run, nor the host_only channel.
  assert.equal(payload.sql, undefined, "no SQL shown to the agent on execute:true");
  assert.equal(payload.host_only, undefined, "host_only channel never reaches the agent");
  assert.ok(!blockText(run, 1).toLowerCase().includes("select "), "agent JSON carries no SQL text");

  // ...but the SQL WAS recorded (matching the old surface): the most recent
  // query row + tool-call row for this dataset carry compiledSql.
  const [petshop] = await db.select().from(datasets).where(eq(datasets.name, "petshop"));
  const [qrow] = await db
    .select({ compiledSql: queries.compiledSql, malloySource: queries.malloySource })
    .from(queries)
    .where(eq(queries.datasetId, petshop!.id))
    .orderBy(desc(queries.createdAt))
    .limit(1);
  assert.match(qrow!.compiledSql ?? "", /select/i, "queries.compiledSql recorded the generated SQL");
  const [tc] = await db
    .select({ compiledSql: toolCalls.compiledSql })
    .from(toolCalls)
    .where(eq(toolCalls.datasetId, petshop!.id))
    .orderBy(desc(toolCalls.createdAt))
    .limit(1);
  assert.match(tc!.compiledSql ?? "", /select/i, "toolCalls.compiledSql recorded the generated SQL");
});

test("query without a question is refused (host policy)", async () => {
  const r = await host().call("query", {
    source: "sales",
    malloy: "run: sales -> { aggregate: total_qty }",
    execute: true,
  });
  assert.equal(r.isError, true);
  assert.match(blockText(r, 0), /question.*is required/i);
});

test("multi-file model: compiles across the import; block 2 slices the entry source", async () => {
  const r = await host().call("describe_source", { source: "pets" });
  assert.equal(r.content.length, 2, "two blocks even for a multi-file model");
  const schema = JSON.parse(blockText(r, 0)) as { ok: boolean; sources: Record<string, unknown> };
  assert.equal(schema.ok, true, "the import resolved and the model compiled");
  assert.ok(schema.sources.pets, "the re-exported source is described");
  // `pets` is declared in index.malloy, so its verbatim body slices from there
  // via hostReadSource — and it references `base` from the imported file.
  assert.match(blockText(r, 1), /source: pets is base extend/, "entry-source text sliced");

  // And it actually runs across the import boundary on DuckDB.
  const run = await host().call("query", {
    source: "pets",
    malloy: "run: pets -> by_animal",
    execute: true,
    question: "by animal",
  });
  const payload = JSON.parse(blockText(run, 1)) as { rows: Array<{ animal: string; total: number }> };
  assert.equal(payload.rows[0]!.total, 2, "import-backed query computed on DuckDB");
});

test("an explicit unknown model_ref refuses without leaking existence", async () => {
  const r = await host().call("describe_source", { source: "sales", model_ref: "ghost" });
  const out = JSON.parse(blockText(r, 0)) as { ok: boolean; problems: Array<{ code: string }> };
  assert.equal(out.ok, false);
  assert.ok(out.problems.some((p) => p.code === "model-not-found"));
});

after(async () => {
  // postgres-js keeps the event loop alive; close the pool so the run exits.
  await (globalThis as { __pg__?: { end?: () => Promise<void> } }).__pg__?.end?.().catch(() => {});
});
