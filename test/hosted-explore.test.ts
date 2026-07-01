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
import { desc, eq, and, isNotNull } from "drizzle-orm";
import { db, users, datasets, malloyModels, malloyModelFiles, history, type User } from "@/db";
import { buildHostedExploreSurface } from "@/lib/mcp-host";
import { loadSharedQuery, runQueryForWeb } from "@/lib/mcp-tools";

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
    // models keyed by model_ref; each model's sources keyed by source_ref.
    models: Record<string, { sources?: Record<string, { description?: string }> }>;
  };
  assert.equal(data.ok, true);
  const entry = data.models["petshop"];
  assert.ok(entry, "petshop is listed");
  const sales = entry!.sources?.["sales"];
  assert.ok(sales, "its `sales` source is listed");
  // Description comes from the model's #" annotation (compiled fresh), not the DB.
  assert.equal(sales!.description, "Pet shop sales.");
});

test("describe_source resolves a bare source: schema (block 0) + verbatim text (block 1)", async () => {
  // This is a HOST-seam test: it checks the host wiring (bare source resolves to
  // its model, two content blocks, block 1 is the verbatim Malloy) and only that
  // block 0 *looks like* a schema. The exact describe_source schema shape is the
  // engine's contract, pinned by its golden tests (packages/mcp-engine/test) —
  // don't re-pin it here, or every engine reshape breaks this test for nothing.
  const r = await host().call("describe_source", { source: "sales" });
  assert.equal(r.content.length, 2, "two content blocks: schema + source text");
  const schema = JSON.parse(blockText(r, 0)) as { ok: boolean; model_ref: string; source: string };
  assert.equal(schema.ok, true);
  assert.equal(schema.model_ref, "petshop", "bare source resolved to its model");
  assert.equal(schema.source, "sales", "the described source is echoed back");
  assert.ok(blockText(r, 0).includes("total_qty"), "block 0 looks like a schema (carries the source's fields)");
  assert.ok(!blockText(r, 0).includes('"body"'), "block 0 carries no raw source text");
  assert.match(blockText(r, 1), /^source: sales is/, "block 1 is verbatim, unescaped Malloy");
  assert.match(blockText(r, 1), /view: by_animal is \{/, "block 1 carries the view definition");
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
    question: "validate by_animal",
  });
  assert.equal((JSON.parse(blockText(v, 0)) as { ok: boolean }).ok, true, "compiles");

  const run = await host().call("query", {
    source: "sales",
    malloy: "run: sales -> { aggregate: total_qty }",
    execute: true,
    question: "total units sold",
  });
  // execute:true is decorated: block 0 = the JSON payload. The summary-reminder
  // text block that used to precede it has been disabled (see mcp-host.ts).
  const payload = JSON.parse(blockText(run, 0)) as {
    rows: Array<{ total_qty: number }>;
    model_ref?: string;
    ltool_link?: { text: string; url: string };
    sql?: unknown;
    host_only?: unknown;
  };
  assert.equal(payload.rows.length, 1, "one aggregate row");
  assert.equal(payload.rows[0]!.total_qty, 6, "DuckDB actually summed 2+3+1");
  assert.equal(payload.model_ref, "petshop", "result reports the resolved model");
  assert.ok(payload.ltool_link?.url, "a share link was minted and recorded");
  assert.match(payload.ltool_link?.text ?? "", /↗/, "link carries a branded label");
  // The agent must NOT see SQL on an executed run, nor the host_only channel.
  assert.equal(payload.sql, undefined, "no SQL shown to the agent on execute:true");
  assert.equal(payload.host_only, undefined, "host_only channel never reaches the agent");
  assert.ok(!blockText(run, 0).toLowerCase().includes("select "), "agent JSON carries no SQL text");

  // ...but the SQL WAS recorded on the run's history row (the run and its audit
  // are now the SAME row): compiledSql + the query text are both there.
  const [petshop] = await db.select().from(datasets).where(eq(datasets.name, "petshop"));
  const [hrow] = await db
    .select({ compiledSql: history.compiledSql, malloy: history.malloyInput })
    .from(history)
    .where(and(eq(history.datasetId, petshop!.id), isNotNull(history.compiledSql)))
    .orderBy(desc(history.createdAt))
    .limit(1);
  assert.match(hrow!.compiledSql ?? "", /select/i, "history.compiledSql recorded the generated SQL for the run");
  assert.match(hrow!.malloy ?? "", /total_qty/, "history.malloyInput recorded the query text");
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

test("multi-file model: compiles across the import; block 1 slices the entry source", async () => {
  const r = await host().call("describe_source", { source: "pets" });
  assert.equal(r.content.length, 2, "two blocks even for a multi-file model");
  // Host-seam check only: the import resolved and `pets` was described. The exact
  // schema shape is the engine's contract (see the describe_source test above).
  const schema = JSON.parse(blockText(r, 0)) as { ok: boolean; source: string };
  assert.equal(schema.ok, true, "the import resolved and the model compiled");
  assert.equal(schema.source, "pets", "the re-exported source is described");
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
  const payload = JSON.parse(blockText(run, 0)) as { rows: Array<{ animal: string; total: number }> };
  assert.equal(payload.rows[0]!.total, 2, "import-backed query computed on DuckDB");
});

test("an explicit unknown model_ref refuses without leaking existence", async () => {
  const r = await host().call("describe_source", { source: "sales", model_ref: "ghost" });
  const out = JSON.parse(blockText(r, 0)) as { ok: boolean; problems: Array<{ code: string }> };
  assert.equal(out.ok, false);
  assert.ok(out.problems.some((p) => p.code === "model-not-found"));
});

test("ltool round-trip: a shared query resolves AND replays (regression: broken share links)", async () => {
  // Execute a query → it mints a share link (inquiry + tool_call carrying source
  // + dataset_id). This is the exact path that broke: a bad recorded source made
  // the link replay fail with "source not found".
  const run = await host().call("query", {
    source: "sales",
    malloy: "run: sales -> { aggregate: total_qty }",
    execute: true,
    question: "ltool round-trip",
  });
  const payload = JSON.parse(blockText(run, 0)) as { ltool_link?: { url: string } };
  const slug = (payload.ltool_link?.url ?? "").replace(/^.*\/ltool\//, "");
  assert.ok(slug, "a share slug was minted");

  // Follow the link.
  const shared = await loadSharedQuery(slug);
  assert.ok(shared.ok, `share link resolves${shared.ok ? "" : ": " + shared.error}`);
  if (!shared.ok) return;
  // The recorded source must be the REAL source, not the dataset/model name —
  // recording the model name (e.g. via a source-derivation that returns nothing)
  // is exactly what broke share links.
  assert.equal(shared.source, "sales", "recorded source is the real source, not the model name");
  assert.ok(shared.datasetId, "share carries the recorded dataset_id (unambiguous replay)");
  assert.ok(shared.malloy, "share carries the malloy");

  // Replay BOTH ways the app does it — by dataset_id (the ltool page) and by
  // source name (legacy). Each must actually RUN and return rows.
  const byId = await runQueryForWeb(user.id, shared.source ?? "", shared.malloy ?? "", 1000, shared.datasetId);
  assert.ok(byId.ok, `replay by dataset_id runs${byId.ok ? "" : ": " + byId.error}`);
  assert.ok(byId.ok && byId.rows.length === 1, "replay by dataset_id returns the aggregate row");
  assert.equal(byId.ok && (byId.rows[0] as { total_qty: number }).total_qty, 6, "ran against the right model");

  const bySource = await runQueryForWeb(user.id, shared.source ?? "", shared.malloy ?? "", 1000);
  assert.ok(bySource.ok, `replay by source name runs${bySource.ok ? "" : ": " + bySource.error}`);
});

test("query refuses a source from the WRONG model_ref (write-side guard)", async () => {
  // `sales` lives in petshop, `pets` in multimod. Querying `sales` against
  // multimod must refuse (source-not-in-model) — never silently run the wrong
  // model or record a wrong (source, model) pair.
  const r = await host().call("query", {
    source: "sales",
    model_ref: "multimod",
    malloy: "run: sales -> { aggregate: total_qty }",
    execute: true,
    question: "wrong model",
  });
  const out = JSON.parse(blockText(r, 0)) as { ok?: boolean; problems?: Array<{ code: string }> };
  assert.equal(out.ok, false);
  assert.ok(out.problems?.some((p) => p.code === "source-not-in-model"), JSON.stringify(out));
});

test("every tool call is audited to tool_calls — non-query tools and failures included", async () => {
  const h = host();

  // B: a non-query tool logs a clean (error-null) audit row — previously these
  // never reached tool_calls at all.
  await h.call("list_sources", {});
  const [ls] = await db
    .select({ error: history.error })
    .from(history)
    .where(eq(history.toolName, "list_sources"))
    .orderBy(desc(history.createdAt))
    .limit(1);
  assert.ok(ls, "list_sources produced an audit row");
  assert.equal(ls!.error, null, "a successful non-query tool logs no error");

  // B: a non-query tool FAILURE records its error string.
  await h.call("describe_source", { source: "no-such-source" });
  const [dsRow] = await db
    .select({ error: history.error })
    .from(history)
    .where(eq(history.toolName, "describe_source"))
    .orderBy(desc(history.createdAt))
    .limit(1);
  assert.ok(dsRow, "describe_source produced an audit row");
  assert.ok((dsRow!.error ?? "").length > 0, "a failed describe_source records its error");

  // A: a FAILED execute:true query records an error row. The old code only
  // recorded successful queries, so a failing query vanished from tool_calls.
  const bad = await h.call("query", {
    source: "sales",
    malloy: "run: sales -> { aggregate: not_a_real_measure }",
    execute: true,
    question: "audit: a deliberately failing query",
  });
  assert.equal((JSON.parse(blockText(bad, 0)) as { ok: boolean }).ok, false, "the query failed");
  const [failRow] = await db
    .select({ error: history.error, malloy: history.malloyInput })
    .from(history)
    .where(and(eq(history.toolName, "query"), isNotNull(history.error)))
    .orderBy(desc(history.createdAt))
    .limit(1);
  assert.ok(failRow, "a failed query produced an audit row (previously dropped)");
  assert.ok((failRow!.error ?? "").length > 0, "the failure's error string was recorded");
  assert.match(failRow!.malloy ?? "", /not_a_real_measure/, "the failing Malloy was recorded for debugging");
});

test("a compile-only (execute:false) query is audited but records no run artifacts", async () => {
  // execute:false validates without running, so it never reached recordQuery and
  // thus never hit tool_calls. It now logs a bare audit row: the Malloy is there
  // (for debugging), but there's no error, no compiled SQL, and no row count —
  // nothing actually ran. Marker string makes the row unambiguous to find.
  const marker = "run: sales -> { aggregate: total_qty } // compile-only-audit-marker";
  const v = await host().call("query", { source: "sales", malloy: marker, execute: false, question: "compile-only marker" });
  assert.equal((JSON.parse(blockText(v, 0)) as { ok: boolean }).ok, true, "compiles");

  const [row] = await db
    .select({
      error: history.error,
      compiledSql: history.compiledSql,
      rowCount: history.rowCount,
      source: history.source,
    })
    .from(history)
    .where(eq(history.malloyInput, marker))
    .limit(1);
  assert.ok(row, "the compile-only query produced an audit row");
  assert.equal(row!.error, null, "a successful compile logs no error");
  assert.equal(row!.compiledSql, null, "nothing ran, so no SQL was recorded");
  assert.equal(row!.rowCount, null, "nothing ran, so no row count was recorded");
  assert.equal(row!.source, "sales", "the queried source is recorded");
});

after(async () => {
  // postgres-js keeps the event loop alive; close the pool so the run exits.
  await (globalThis as { __pg__?: { end?: () => Promise<void> } }).__pg__?.end?.().catch(() => {});
});
