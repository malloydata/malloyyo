// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT
//
// Load test for the hosted explore surface: how list_sources, describe_source
// and query scale with the number of datasets, and whether a burst of
// concurrent queries (shaped like dashboards) completes.
//
//   npm run load-test                       # 100 datasets, 100 concurrent
//   LOAD_DATASETS=20 npm run load-test      # smaller
//
// `npm run load-test` runs this through scripts/hosted-test.sh --run, which
// stands up a THROWAWAY Postgres and applies the schema, exactly as the hosted
// integration tests do. It is destructive in the same way: never point it at a
// database you care about.
//
// What it calls is the real seam the /mcp route wraps,
// buildHostedExploreSurface(...).call(), in process, so the numbers are the
// server's own cost with no HTTP or auth in front. Models run on in-process
// DuckDB, where a schema fetch is cheap; against a remote warehouse every
// compile also pays a network round trip per source, so read these as a floor.
//
// Knobs (env):
//   LOAD_DATASETS     datasets to seed                       (100)
//   LOAD_CONCURRENCY  calls fired at once in the burst phase (100)
//   LOAD_DEADLINE_S   a call that has not settled by then counts as HUNG (180)
//   LOAD_OUT          also write the results as JSON to this path
//
// Exit status: 0 when every call settled, 2 when any call hung.

import { db, users, datasets, malloyModels, malloyModelFiles, type User } from "@/db";
import { buildHostedExploreSurface } from "@/lib/mcp-host";
import { writeFileSync } from "node:fs";

// No product telemetry from a load test: it would report synthetic traffic.
process.env.MALLOYYO_TELEMETRY_DISABLED ??= "1";

const N = intEnv("LOAD_DATASETS", 100);
const CONCURRENCY = intEnv("LOAD_CONCURRENCY", 100);
const DEADLINE_MS = intEnv("LOAD_DEADLINE_S", 180) * 1000;

function intEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Each dataset gets its own source name, so a bare `source` resolves to one model. */
function modelFor(i: number): string {
  return `#" Load-test dataset ${i}.
#" Numbers 0..19999, bucketed.
source: src_${i} is duckdb.sql("""select range as n, range % 7 as k, range % 100 as h from range(20000)""") extend {
  measure: total is n.sum()
  measure: row_count is count()
  #" Totals per bucket.
  view: by_k is { group_by: k; aggregate: total, row_count }
  view: by_h is { group_by: h; aggregate: total }
}
`;
}

async function seed(): Promise<User> {
  const [user] = await db.insert(users).values({ email: "load@test.local" }).returning();
  for (let i = 0; i < N; i++) {
    const [ds] = await db
      .insert(datasets)
      .values({ userId: user.id, name: `load_${i}`, status: "ready", isPublic: false })
      .returning();
    const source = modelFor(i);
    const [m] = await db
      .insert(malloyModels)
      .values({
        datasetId: ds.id,
        version: 1,
        active: true,
        source,
        generatedBy: "load-test",
        compiledAt: new Date(),
        sources: [{ name: `src_${i}`, description: `Load-test dataset ${i}.` }],
      })
      .returning();
    await db.insert(malloyModelFiles).values({ modelId: m.id, path: "index.malloy", content: source });
  }
  return user;
}

type Outcome = { ms: number; status: "ok" | "error" | "hung"; error?: string };

type Surface = ReturnType<typeof buildHostedExploreSurface>;

/** One tool call, raced against the deadline. A hung call keeps running; we stop waiting. */
async function timed(surface: Surface, tool: string, args: Record<string, unknown>): Promise<Outcome> {
  const t0 = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"hung">((resolve) => {
    timer = setTimeout(() => resolve("hung"), DEADLINE_MS);
  });
  try {
    const r = await Promise.race([surface.call(tool, args), deadline]);
    const ms = performance.now() - t0;
    if (r === "hung") return { ms, status: "hung" };
    const sc = (r as { structuredContent?: { ok?: boolean; problems?: Array<{ message?: string }> } })
      .structuredContent;
    if (sc?.ok === false) return { ms, status: "error", error: sc.problems?.[0]?.message ?? "not ok" };
    return { ms, status: "ok" };
  } catch (err) {
    return { ms: performance.now() - t0, status: "error", error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function pct(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

type PhaseResult = {
  phase: string;
  calls: number;
  ok: number;
  errors: number;
  hung: number;
  p50_ms: number;
  p99_ms: number;
  max_ms: number;
  wall_ms: number;
  first_errors: string[];
};

function summarize(phase: string, outcomes: Outcome[], wallMs: number): PhaseResult {
  const ms = outcomes.filter((o) => o.status !== "hung").map((o) => o.ms);
  const errors = outcomes.filter((o) => o.status === "error");
  return {
    phase,
    calls: outcomes.length,
    ok: outcomes.filter((o) => o.status === "ok").length,
    errors: errors.length,
    hung: outcomes.filter((o) => o.status === "hung").length,
    p50_ms: Math.round(pct(ms, 50)),
    p99_ms: Math.round(pct(ms, 99)),
    max_ms: Math.round(ms.length ? Math.max(...ms) : NaN),
    wall_ms: Math.round(wallMs),
    first_errors: [...new Set(errors.map((e) => e.error ?? ""))].slice(0, 3),
  };
}

async function sequential(name: string, n: number, call: (i: number) => Promise<Outcome>): Promise<PhaseResult> {
  const outcomes: Outcome[] = [];
  const t0 = performance.now();
  for (let i = 0; i < n; i++) outcomes.push(await call(i));
  return summarize(name, outcomes, performance.now() - t0);
}

async function main() {
  console.log(`→ seeding ${N} datasets`);
  const user = await seed();
  const surface = buildHostedExploreSurface(user, "http://localhost:3000");
  const query = (i: number, malloy: string, withRef: boolean) =>
    timed(surface, "query", {
      source: `src_${i}`,
      malloy,
      ...(withRef ? { model_ref: `load_${i}` } : {}),
      question: "load test",
    });

  const results: PhaseResult[] = [];
  const report = (r: PhaseResult) => {
    results.push(r);
    const errs = r.first_errors.length ? `  errors: ${r.first_errors.join(" | ")}` : "";
    console.log(
      `  ${r.phase.padEnd(34)} calls ${String(r.calls).padStart(3)}  ok ${String(r.ok).padStart(3)}  ` +
        `err ${String(r.errors).padStart(3)}  hung ${String(r.hung).padStart(3)}  ` +
        `p50 ${String(r.p50_ms).padStart(6)}ms  p99 ${String(r.p99_ms).padStart(6)}ms  wall ${String(r.wall_ms).padStart(7)}ms${errs}`,
    );
  };

  console.log(`→ sequential phases (deadline ${DEADLINE_MS / 1000}s per call)`);
  report(await sequential("list_sources, first call", 1, () => timed(surface, "list_sources", {})));
  report(await sequential("list_sources, repeated", 5, () => timed(surface, "list_sources", {})));
  report(
    await sequential("describe_source, bare source", 5, (i) =>
      timed(surface, "describe_source", { source: `src_${i % N}` }),
    ),
  );
  report(
    await sequential("query with model_ref", 10, (i) => query(i % N, `run: src_${i % N} -> by_k`, true)),
  );

  // The burst: dashboards fire their tiles at once. Up to four dashboards of 20
  // tiles on the first datasets, the rest single agent queries spread over the
  // others, all started together.
  const dashboards = Math.min(4, Math.floor(CONCURRENCY / 20));
  const singles = CONCURRENCY - dashboards * 20;
  console.log(`→ burst: ${dashboards} dashboards × 20 tiles + ${singles} single queries, all at once`);
  const calls: Array<Promise<Outcome>> = [];
  for (let d = 0; d < dashboards; d++) {
    const i = d % N;
    for (let t = 0; t < 20; t++) {
      calls.push(query(i, t % 2 ? `run: src_${i} -> by_k` : `run: src_${i} -> by_h`, true));
    }
  }
  for (let s = 0; s < singles; s++) {
    const i = (dashboards + s) % N;
    calls.push(query(i, `run: src_${i} -> { aggregate: total }`, false));
  }
  const t0 = performance.now();
  const outcomes = await Promise.all(calls);
  report(summarize(`burst of ${CONCURRENCY} queries`, outcomes, performance.now() - t0));

  const hung = results.reduce((n, r) => n + r.hung, 0);
  const out = { datasets: N, concurrency: CONCURRENCY, deadline_s: DEADLINE_MS / 1000, results };
  if (process.env.LOAD_OUT) writeFileSync(process.env.LOAD_OUT, JSON.stringify(out, null, 2));
  console.log(hung ? `✗ ${hung} call(s) hung` : "✓ every call settled");
  // Hung calls are still pending; don't wait for them.
  process.exit(hung ? 2 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
