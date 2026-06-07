#!/usr/bin/env tsx
// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT
/* e2e: NYC taxi → ready → MCP query. Run with `pnpm e2e`. */

const BASE = process.env.APP_BASE_URL ?? "http://localhost:3000";
const DATASET_URL =
  process.env.E2E_DATASET_URL ??
  "https://d37ci6vzurychx.cloudfront.net/trip-data/yellow_tripdata_2024-01.parquet";
const NAME = "yellow_taxi_e2e";

const TIMEOUT_MS = 5 * 60_000;
const POLL_MS = 2000;

type RegisterResp = {
  id: string;
  name: string;
  status: string;
  runId: string;
  userSlug: string;
  mcpUrl: string;
};

type DetailResp = {
  id: string;
  status: string;
  statusError: string | null;
  sizeBytes: number | null;
  workflowRunId: string | null;
  malloyModel: { source: string } | null;
};

async function register(): Promise<RegisterResp> {
  const r = await fetch(`${BASE}/api/datasets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceUrl: DATASET_URL, name: NAME }),
  });
  if (!r.ok) throw new Error(`register: ${r.status} ${await r.text()}`);
  return r.json();
}

async function detail(id: string): Promise<DetailResp> {
  const r = await fetch(`${BASE}/api/datasets/${id}`);
  if (!r.ok) throw new Error(`detail ${id}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function mcpCall(slug: string, name: string, args: Record<string, unknown>) {
  const r = await fetch(`${BASE}/mcp/${slug}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  if (!r.ok) throw new Error(`mcp ${name}: ${r.status} ${await r.text()}`);
  const json = await r.json();
  if (json.error) throw new Error(`mcp ${name} rpc error: ${JSON.stringify(json.error)}`);
  return json.result as { content: Array<{ type: "text"; text: string }>; isError?: boolean };
}

async function waitUntilReady(id: string) {
  const t0 = Date.now();
  while (Date.now() - t0 < TIMEOUT_MS) {
    const d = await detail(id);
    process.stdout.write(`  status=${d.status}${d.sizeBytes ? ` size=${(d.sizeBytes/1024/1024).toFixed(1)}MiB` : ""}\n`);
    if (d.status === "ready") return d;
    if (d.status === "failed") {
      throw new Error(`pipeline failed: ${d.statusError ?? "(no error)"}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`timeout after ${TIMEOUT_MS}ms`);
}

async function main() {
  console.log(`[e2e] base=${BASE}`);
  console.log(`[e2e] register dataset url=${DATASET_URL}`);
  const reg = await register();
  console.log(`[e2e] id=${reg.id} runId=${reg.runId} mcp=${reg.mcpUrl}`);

  console.log("[e2e] waiting for ready…");
  const final = await waitUntilReady(reg.id);
  console.log(`[e2e] ready. model:\n${final.malloyModel?.source}`);

  console.log("[e2e] MCP tools/list");
  const list = await fetch(`${BASE}${reg.mcpUrl}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list" }),
  }).then((r) => r.json());
  console.log("  tools:", list.result?.tools?.map((t: { name: string }) => t.name).join(", "));

  console.log("[e2e] MCP run_analytical_query: count()");
  const count = await mcpCall(reg.userSlug, "run_analytical_query", {
    dataset: NAME,
    malloy: `run: ${NAME} -> { aggregate: trip_count is count() }`,
  });
  console.log("  result:", JSON.stringify(JSON.parse(count.content[0].text), null, 2));
  if (count.isError) throw new Error("count query returned isError");

  console.log("[e2e] MCP run_analytical_query: aggregate by passenger_count");
  const grouped = await mcpCall(reg.userSlug, "run_analytical_query", {
    dataset: NAME,
    malloy: `run: ${NAME} -> {
      group_by: passenger_count
      aggregate:
        trip_count is count()
      order_by: trip_count desc
      limit: 10
    }`,
  });
  console.log("  result:", grouped.content[0].text);
  if (grouped.isError) throw new Error("grouped query returned isError");

  console.log("[e2e] OK ✓");
}

main().catch((err) => {
  console.error("[e2e] FAILED:", err.message ?? err);
  process.exit(1);
});
