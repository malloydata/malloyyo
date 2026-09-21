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
import { createApiToken, hashApiToken } from "@/lib/api-tokens";
import { listDashboardsAndDrafts } from "@/lib/dashboards";
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

let userId: string;
let mcpToken: string;
let streamToken: { id: string; raw: string };
let publishToken: string;

before(async () => {
  const [u] = await db
    .insert(users)
    .values({ email: "route@test.local", status: "active", role: "member" })
    .returning();
  userId = u.id;
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
    // The repo's image allowlist: the panel must carry it as a CSP, or a
    // dashboard's <img src> silently shows nothing inside Claude.
    {
      modelId: m.id,
      path: "malloy-config.json",
      // The connections block is the rest of a real repo's config: a config
      // file with none replaces the model's default connection.
      content: JSON.stringify({
        connections: { duckdb: { is: "duckdb" } },
        malloyyo: { image_hosts: ["image.tmdb.org", "*.cdn.example.com"] },
      }),
    },
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

test("show_dashboard refuses a dashboard that doesn't exist, naming the ones that do", async () => {
  const client = await connect(mcpToken, { mode: { pin: "2026-07-28" } });
  try {
    const missing = await client.callTool({
      name: "show_dashboard",
      arguments: { dataset: "petshop", dashboard: "nope" },
    });
    assert.equal(missing.isError, true);
    const msg = JSON.stringify(missing.content);
    assert.match(msg, /No dashboard 'nope' in 'petshop'/);
    assert.match(msg, /overview/);
    assert.match(msg, /local/);

    // An unknown dataset reads the same as one the user can't see.
    const noDataset = await client.callTool({
      name: "show_dashboard",
      arguments: { dataset: "no_such_dataset", dashboard: "overview" },
    });
    assert.equal(noDataset.isError, true);
    assert.match(JSON.stringify(noDataset.content), /No dashboards found for 'no_such_dataset'/);
  } finally {
    await client.close();
  }
});

test("issue_cli_token: a query-only, hour-long token for THIS server's URL, that works", async () => {
  const client = await connect(mcpToken, { mode: { pin: "2026-07-28" } });
  try {
    const r = await client.callTool({ name: "issue_cli_token", arguments: {} });
    assert.notEqual(r.isError, true);
    const out = r.structuredContent as { url: string; token: string; expires_at: string; login: string };
    assert.equal(out.url, "http://localhost:3000", "the URL the client reached us at");
    assert.equal(out.login, "malloyyo login http://localhost:3000 --token-stdin");
    const ttl = Date.parse(out.expires_at) - Date.now();
    assert.ok(ttl > 55 * 60_000 && ttl <= 60 * 60_000, `expires in about an hour (${ttl} ms)`);

    const [row] = await db.select().from(apiTokens).where(eq(apiTokens.tokenHash, hashApiToken(out.token)));
    assert.deepEqual(row?.scopes, ["mcp"], "query scope only, never publish");

    // And it opens /mcp.
    const cli = await connect(out.token, { mode: "legacy" });
    assert.ok((await cli.listTools()).tools.length > 0);
    await cli.close();
  } finally {
    await client.close();
  }
});

test("save_draft_dashboard: saves a draft that every dashboard tool then serves", async () => {
  const client = await connect(mcpToken, { mode: { pin: "2026-07-28" } });
  try {
    const malloy = `##! experimental { access_modifiers givens }\nimport "../index.malloy"\n# artifact { title="Animals" }\nquery: animals is sales -> { group_by: animal; aggregate: total_qty }\n`;
    const saved = await client.callTool({
      name: "save_draft_dashboard",
      arguments: { dataset: "petshop", name: "animals", malloy },
    });
    assert.notEqual(saved.isError, true, JSON.stringify(saved.content));
    const out = saved.structuredContent as {
      dashboard: string;
      slug: string;
      url: string;
      tiles: Array<{ ok: boolean; rowCount?: number }>;
    };
    assert.match(out.dashboard, /^draft-[a-z0-9]+$/);
    assert.equal(out.url, `http://localhost:3000/datasets/petshop/dashboard/${out.dashboard}`);
    assert.equal(out.tiles.length, 1);
    assert.ok(out.tiles[0].ok);

    // The draft is a dashboard like any other, by its scratch name.
    const shown = await client.callTool({
      name: "show_dashboard",
      arguments: { dataset: "petshop", dashboard: out.dashboard },
    });
    assert.notEqual(shown.isError, true);
    const ran = await client.callTool({
      name: "dashboard_run",
      arguments: { datasetId: "petshop", name: out.dashboard, query: "animals" },
    });
    const run = ran.structuredContent as { ok: boolean; rowCount?: number; error?: string };
    assert.equal(run.ok, true, run.error);
    assert.equal(run.rowCount, 2);

    // Re-saving with the slug updates it in place.
    const again = await client.callTool({
      name: "save_draft_dashboard",
      arguments: { dataset: "petshop", name: "animals", malloy: malloy.replace("Animals", "Animals v2"), slug: out.slug },
    });
    assert.equal((again.structuredContent as { slug: string }).slug, out.slug);
    assert.match(JSON.stringify(again.content), /Animals v2/);
  } finally {
    await client.close();
  }
});

test("save_draft_dashboard: the restricted gate runs before anything compiles", async () => {
  const client = await connect(mcpToken, { mode: { pin: "2026-07-28" } });
  try {
    const TAG = `# artifact { title="x" }`;
    for (const [what, malloy, why] of [
      ["raw SQL", `import "../index.malloy"\n${TAG}\nquery: q is duckdb.sql("select 1 as x") -> { select: x }`, /raw SQL is not permitted/],
      ["a connection", `import "../index.malloy"\n${TAG}\nquery: q is duckdb.table("t") -> { select: * }`, /direct table access is not permitted/],
      ["another import", `import "../index.malloy"\nimport "../other.malloy"\n${TAG}\nquery: q is sales -> { aggregate: total_qty }`, /file imports are not permitted/],
      ["an unlisted flag", `##! experimental { sql_functions }\nimport "../index.malloy"\n${TAG}\nquery: q is sales -> { aggregate: total_qty }`, /compiler-flag annotations/],
    ] as const) {
      const r = await client.callTool({
        name: "save_draft_dashboard",
        arguments: { dataset: "petshop", name: "x", malloy },
      });
      assert.equal(r.isError, true, `${what} should be refused`);
      assert.match(JSON.stringify(r.content), why, what);
    }
  } finally {
    await client.close();
  }
});

test("save_draft_dashboard: a component alone is a dashboard, and its inline queries are checked", async () => {
  const client = await connect(mcpToken, { mode: { pin: "2026-07-28" } });
  try {
    const component = (field: string) => `import { useQuery } from "@malloyyo/dashboard";
export default function D() {
  const { rows } = useQuery({ malloy: \`run: sales -> { group_by: ${field}; aggregate: total_qty }\` });
  return <ol>{rows.map((r) => <li key={String(r.${field})}>{String(r.${field})}</li>)}</ol>;
}
`;
    // No dashboards/<name>.malloy at all: the queries live in the component and
    // run against the model's published surface, like any restricted query.
    const bad = await client.callTool({
      name: "save_draft_dashboard",
      arguments: { dataset: "petshop", name: "inline", title: "Inline", source: component("animl") },
    });
    assert.notEqual(bad.isError, true, "a bad inline query is a report, not a refusal");
    const badOut = bad.structuredContent as { slug: string; tiles: Array<{ ok: boolean; error?: string }> };
    assert.equal(badOut.tiles[0]?.ok, false);
    assert.match(badOut.tiles[0]?.error ?? "", /'animl' is not defined/);

    const good = await client.callTool({
      name: "save_draft_dashboard",
      arguments: { dataset: "petshop", name: "inline", title: "Inline", source: component("animal"), slug: badOut.slug },
    });
    const out = good.structuredContent as { slug: string; title: string; tiles: Array<{ ok: boolean }> };
    assert.equal(out.slug, badOut.slug);
    assert.equal(out.title, "Inline");
    assert.ok(out.tiles.every((t) => t.ok));

    // It renders as a custom dashboard: a queryless manifest, source and all.
    const view = await client.callTool({
      name: "dashboard_bundle",
      arguments: { datasetId: "petshop", name: `draft-${out.slug}` },
    });
    const bundle = view.structuredContent as { ok: boolean; title: string; js?: string };
    assert.equal(bundle.ok, true);
    assert.equal(bundle.title, "Inline");
    assert.ok((bundle.js ?? "").length > 0);
  } finally {
    await client.close();
  }
});

test("the panel declares the image hosts the models allow, so dashboard images load", async () => {
  const client = await connect(mcpToken, { mode: { pin: "2026-07-28" } });
  try {
    const show = (await client.listTools()).tools.find((t) => t.name === "show_dashboard")!;
    const uri = (show._meta?.ui as { resourceUri: string }).resourceUri;
    const read = await client.readResource({ uri });
    const meta = read.contents[0]?._meta as { ui?: { csp?: { resourceDomains?: string[] } } } | undefined;
    const domains = meta?.ui?.csp?.resourceDomains ?? [];
    assert.ok(domains.includes("https://image.tmdb.org"), `got ${JSON.stringify(domains)}`);
    assert.ok(domains.includes("https://*.cdn.example.com"), "wildcards survive");
  } finally {
    await client.close();
  }
});

test("a draft's inline queries are checked against its own .malloy, not index.malloy", async () => {
  const client = await connect(mcpToken, { mode: { pin: "2026-07-28" } });
  try {
    // The component queries a source only the draft's own file defines — which
    // is what it will compile against when a reader opens it.
    const r = await client.callTool({
      name: "save_draft_dashboard",
      arguments: {
        dataset: "petshop",
        name: "local_src",
        malloy: `import "../index.malloy"\nsource: local_sales is sales extend { measure: n is count() }\n# artifact { title="Local" }\nquery: q is local_sales -> { aggregate: n }\n`,
        source: `import { useQuery } from "@malloyyo/dashboard";
export default function D() {
  const q = useQuery({ malloy: \`run: local_sales -> { aggregate: n }\` });
  return <div>{(q.rows ?? []).length}</div>;
}
`,
      },
    });
    assert.notEqual(r.isError, true, JSON.stringify(r.content));
    const out = r.structuredContent as { tiles: Array<{ run: string; ok: boolean; error?: string }> };
    const failed = out.tiles.filter((t) => !t.ok);
    assert.equal(failed.length, 0, `nothing should fail: ${JSON.stringify(failed)}`);
  } finally {
    await client.close();
  }
});

test("re-saving a draft keeps the title and description it already had", async () => {
  const client = await connect(mcpToken, { mode: { pin: "2026-07-28" } });
  try {
    const component = `export default function D() { return <div/>; }`;
    const first = await client.callTool({
      name: "save_draft_dashboard",
      arguments: {
        dataset: "petshop",
        name: "keeps",
        title: "Keeps its name",
        description: "and its subtitle",
        source: component,
      },
    });
    const { slug } = first.structuredContent as { slug: string };

    // The iterate loop: component only, no title restated.
    const again = await client.callTool({
      name: "save_draft_dashboard",
      arguments: { dataset: "petshop", name: "keeps", source: `${component}\n// edited`, slug },
    });
    const out = again.structuredContent as { title: string };
    assert.equal(out.title, "Keeps its name");
    const listed = await listDashboardsAndDrafts(userId, "petshop");
    const row = listed.find((d) => d.name === `draft-${slug}`);
    assert.equal(row?.title, "Keeps its name");
    assert.equal(row?.description, "and its subtitle");
  } finally {
    await client.close();
  }
});

test("a published dashboard whose name starts with draft- is still reachable", async () => {
  // `draft-<slug>` is a convention, not a reserved namespace.
  const [model] = await db
    .select()
    .from(malloyModels)
    .where(eq(malloyModels.datasetId, (await db.select().from(datasets).where(eq(datasets.name, "petshop")))[0].id))
    .limit(1);
  await db.insert(malloyArtifacts).values({
    modelId: model.id,
    name: "draft-notes",
    title: "Notes",
    manifest: { title: "Notes" },
    source: "",
  });
  const client = await connect(mcpToken, { mode: { pin: "2026-07-28" } });
  try {
    const shown = await client.callTool({
      name: "show_dashboard",
      arguments: { dataset: "petshop", dashboard: "draft-notes" },
    });
    assert.notEqual(shown.isError, true, JSON.stringify(shown.content));
  } finally {
    await client.close();
  }
});

test("a query held in a const is checked at save, like one written in the call", async () => {
  // Real components keep their query in a `const` and pass the variable. A
  // check that only looked inside useQuery({…}) reported "0/0 ran" and left
  // the mistake for the first person to open the page.
  const client = await connect(mcpToken, { mode: { pin: "2026-07-28" } });
  try {
    const r = await client.callTool({
      name: "save_draft_dashboard",
      arguments: {
        dataset: "petshop",
        name: "const_query",
        title: "Const query",
        source: `import { useQuery } from "@malloyyo/dashboard";
const TREND = \`run: sales -> { group_by: animl; aggregate: total_qty }\`;
export default function D() {
  const q = useQuery({ malloy: TREND });
  return <div>{(q.rows ?? []).length}</div>;
}`,
      },
    });
    const out = r.structuredContent as { tiles: Array<{ ok: boolean; error?: string }> };
    assert.equal(out.tiles.length, 1, "the const's query was found");
    assert.equal(out.tiles[0].ok, false);
    assert.match(out.tiles[0].error ?? "", /'animl' is not defined/);
  } finally {
    await client.close();
  }
});

test("a document — source: … run: … — is accepted wherever a query is", async () => {
  // The same text the `query` tool takes. The runtime used to prefix it with
  // `run:`, making `run: source: …`.
  const client = await connect(mcpToken, { mode: { pin: "2026-07-28" } });
  try {
    const doc = `source: recent is sales extend { measure: n is total_qty }\nrun: recent -> { group_by: animal; aggregate: n }`;
    const saved = await client.callTool({
      name: "save_draft_dashboard",
      arguments: {
        dataset: "petshop",
        name: "doc_query",
        title: "Document query",
        source: `import { useQuery } from "@malloyyo/dashboard";\nconst Q = \`${doc}\`;\nexport default function D() { const q = useQuery({ malloy: Q }); return <div>{(q.rows ?? []).length}</div>; }`,
      },
    });
    const out = saved.structuredContent as { dashboard: string; tiles: Array<{ ok: boolean; error?: string }> };
    assert.equal(out.tiles[0]?.ok, true, out.tiles[0]?.error);

    const ran = await client.callTool({
      name: "dashboard_run",
      arguments: { datasetId: "petshop", name: out.dashboard, malloy: doc },
    });
    const run = ran.structuredContent as { ok: boolean; rowCount?: number; error?: string };
    assert.equal(run.ok, true, run.error);
    assert.equal(run.rowCount, 2);
  } finally {
    await client.close();
  }
});

test("Malloy that defines things but runs nothing says so", async () => {
  const client = await connect(mcpToken, { mode: { pin: "2026-07-28" } });
  try {
    const saved = await client.callTool({
      name: "save_draft_dashboard",
      arguments: { dataset: "petshop", name: "norun", title: "No run", source: "export default function D() { return <div/>; }" },
    });
    const { dashboard } = saved.structuredContent as { dashboard: string };
    const ran = await client.callTool({
      name: "dashboard_run",
      arguments: { datasetId: "petshop", name: dashboard, malloy: "source: x is sales extend { measure: n is count() }" },
    });
    const run = ran.structuredContent as { ok: boolean; error?: string };
    assert.equal(run.ok, false);
    assert.match(run.error ?? "", /never runs one/, "not an internal compiler error");
  } finally {
    await client.close();
  }
});
