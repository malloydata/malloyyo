// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT
//
// Integration test for the /mcp ROUTE (src/app/mcp/route.ts): the official
// MCP client (@modelcontextprotocol/client) → the real route handler → a real
// Postgres, with a real API token. hosted-explore.test.ts covers the surface
// the route wraps; this covers the protocol around it, which is the part that
// broke silently when it was hand-rolled — a 2026-07-28 client rejected every
// tools/list and so saw zero tools, while older clients worked fine.
//
// The client's `fetch` is the route's own handler, so there is no HTTP server:
// same handler code, same wire contract.
//
// Run via `npm run test:hosted`.

import test, { before } from "node:test";
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { eq } from "drizzle-orm";
import { db, users, datasets, malloyModels, malloyModelFiles, malloyArtifacts, apiTokens } from "@/db";
import { createApiToken } from "@/lib/api-tokens";
import { DELETE, GET, POST } from "@/app/mcp/route";

const MCP_URL = "http://localhost:3000/mcp";
const UI_EXTENSION = "io.modelcontextprotocol/ui";
const APP_MIME = "text/html;profile=mcp-app";

const MODEL = `#" Pet shop sales.
source: sales is duckdb.sql("""
  SELECT 'dog' as animal, 2 as qty UNION ALL SELECT 'cat', 3
""") extend {
  measure: total_qty is qty.sum()
}
`;

const LOCAL_DASHBOARD = `import "../index.malloy"
source: local_sales is sales extend {
  measure: animal_count is count()
}
`;

let mcpToken: string;
let streamToken: { id: string; raw: string };
let publishToken: string;

before(async () => {
  const [u] = await db
    .insert(users)
    .values({ email: "route@test.local", status: "active", role: "member" })
    .returning();
  const [ds] = await db
    .insert(datasets)
    .values({ userId: u.id, name: "petshop", status: "ready", isPublic: false })
    .returning();
  const [m] = await db
    .insert(malloyModels)
    .values({
      datasetId: ds.id,
      version: 1,
      source: MODEL,
      generatedBy: "test",
      compiledAt: new Date(),
      sources: [{ name: "sales", description: "Pet shop sales." }],
    })
    .returning();
  await db.insert(malloyModelFiles).values([
    { modelId: m.id, path: "index.malloy", content: MODEL },
    // A v2 dashboard file defining a source index.malloy does NOT publish.
    { modelId: m.id, path: "dashboards/local.malloy", content: LOCAL_DASHBOARD },
  ]);
  await db.insert(malloyArtifacts).values([
    { modelId: m.id, name: "overview", title: "Overview", manifest: {}, source: "" },
    {
      modelId: m.id,
      name: "local",
      title: "Local",
      manifest: { entryFile: "dashboards/local.malloy" },
      source: "",
    },
  ]);

  const mcp = await createApiToken({ userId: u.id, name: "route-mcp", scopes: ["mcp"], expiresAt: null });
  const pub = await createApiToken({ userId: u.id, name: "route-pub", scopes: ["publish"], expiresAt: null });
  assert.ok(mcp.ok && pub.ok);
  mcpToken = mcp.raw;
  publishToken = pub.raw;
  const stream = await createApiToken({ userId: u.id, name: "route-stream", scopes: ["mcp"], expiresAt: null });
  assert.ok(stream.ok);
  streamToken = { id: stream.token.id, raw: stream.raw };
});

/** Route the client's HTTP straight into the handler. */
async function routeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const req = new Request(input, init);
  const handler = req.method === "GET" ? GET : req.method === "DELETE" ? DELETE : POST;
  return handler(req);
}

type Negotiation = ConstructorParameters<typeof Client>[1] extends infer O
  ? O extends { versionNegotiation?: infer V } ? V : never
  : never;

async function connect(token: string, versionNegotiation?: Negotiation): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: routeFetch,
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client(
    { name: "route-test", version: "0.0.0" },
    { versionNegotiation, capabilities: { extensions: { [UI_EXTENSION]: { mimeTypes: [APP_MIME] } } } },
  );
  await client.connect(transport);
  return client;
}

test("no bearer → 401 pointing at the protected-resource metadata", async () => {
  const res = await POST(
    new Request(MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata=".*\/\.well-known\/oauth-protected-resource"/);
});

test("a publish-only token cannot open /mcp", async () => {
  await assert.rejects(connect(publishToken));
});

const MODES: Array<[string, Negotiation | undefined]> = [
  ["legacy (2025 initialize)", { mode: "legacy" }],
  ["modern (2026-07-28 server/discover)", { mode: { pin: "2026-07-28" } }],
  ["auto (the client default)", undefined],
];

for (const [label, negotiation] of MODES) {
  test(`${label}: tools, the dashboard app, and a real call`, async () => {
    const client = await connect(mcpToken, negotiation);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      for (const n of ["list_sources", "describe_source", "query", "show_dashboard"]) {
        assert.ok(names.includes(n), `${n} missing from ${names.join(", ")}`);
      }

      // show_dashboard is bound to the panel resource, and the panel reads.
      const show = tools.find((t) => t.name === "show_dashboard")!;
      const uri = (show._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri;
      assert.match(uri ?? "", /^ui:\/\/dashboard\/panel-[0-9a-f]+\.html$/);
      const panel = await client.readResource({ uri: uri! });
      assert.equal(panel.contents[0]?.mimeType, APP_MIME);
      assert.ok(((panel.contents[0] as { text?: string }).text ?? "").includes("<!DOCTYPE html>"));

      // The panel-only tools are marked app-visible only.
      const bundle = tools.find((t) => t.name === "dashboard_bundle");
      if (bundle) {
        assert.deepEqual((bundle._meta?.ui as { visibility?: string[] }).visibility, ["app"]);
      }

      // list_sources reports the model's dashboard; show_dashboard names it.
      const listed = await client.callTool({ name: "list_sources", arguments: {} });
      assert.notEqual(listed.isError, true);
      const models = (listed.structuredContent as { models: Record<string, { dashboards?: object }> }).models;
      assert.ok(models.petshop?.dashboards && "overview" in models.petshop.dashboards);

      const shown = await client.callTool({
        name: "show_dashboard",
        arguments: { dataset: "petshop", dashboard: "overview" },
      });
      assert.deepEqual(shown.structuredContent, { ok: true, datasetId: "petshop", name: "overview" });
    } finally {
      await client.close();
    }
  });
}

test("the engine, not the SDK, validates explore-tool arguments", async () => {
  const client = await connect(mcpToken, { mode: { pin: "2026-07-28" } });
  try {
    // Missing required `source`: SDK-side validation would answer with a bare
    // "Input validation error"; the engine reaches its own handler and answers.
    const r = await client.callTool({
      name: "query",
      arguments: { malloy: "run: sales -> { aggregate: total_qty }", execute: false },
    });
    const text = JSON.stringify(r.content);
    assert.doesNotMatch(text, /Input validation error/);
  } finally {
    await client.close();
  }
});

test("dashboard_run: ad-hoc Malloy sees the dashboard file's own sources", async () => {
  // Suggestions and <VegaChart malloy=…> send ad-hoc text that may name a source
  // only the dashboard file defines. It must compile against that file, as it
  // does in `malloyyo dashboard dev` — not against index.malloy.
  const client = await connect(mcpToken, { mode: { pin: "2026-07-28" } });
  try {
    for (const args of [
      { query: "run: local_sales -> { aggregate: animal_count }" }, // the panel's one-field form
      { malloy: "run: local_sales -> { aggregate: animal_count }" }, // the web frame's form
    ]) {
      const r = await client.callTool({
        name: "dashboard_run",
        arguments: { datasetId: "petshop", name: "local", ...args },
      });
      const out = r.structuredContent as { ok: boolean; error?: string; rowCount?: number };
      assert.equal(out.ok, true, `${JSON.stringify(args)} → ${out.error}`);
      assert.equal(out.rowCount, 1);
    }
  } finally {
    await client.close();
  }
});

test("GET and DELETE answer 405 without touching last_used_at", async () => {
  const lastUsed = async () =>
    (await db.select().from(apiTokens).where(eq(apiTokens.id, streamToken.id)))[0]?.lastUsedAt ?? null;

  // Opening a stream (or ending a session that doesn't exist) is not a use:
  // a client that reconnects its GET in a loop must not write on every try.
  for (const method of ["GET", "DELETE"]) {
    for (const headers of [{}, { authorization: `Bearer ${streamToken.raw}` }] as Record<string, string>[]) {
      const res = await (method === "GET" ? GET : DELETE)(new Request(MCP_URL, { method, headers }));
      assert.equal(res.status, 405, `${method} ${Object.keys(headers).length ? "with" : "without"} a token`);
      assert.equal(res.headers.get("allow"), "POST, OPTIONS");
    }
  }
  assert.equal(await lastUsed(), null);

  // The same token on a real request IS a use — so the assertion above means something.
  const client = await connect(streamToken.raw, { mode: "legacy" });
  await client.listTools();
  await client.close();
  for (let i = 0; i < 20 && (await lastUsed()) === null; i++) await new Promise((r) => setTimeout(r, 100));
  assert.notEqual(await lastUsed(), null);
});
