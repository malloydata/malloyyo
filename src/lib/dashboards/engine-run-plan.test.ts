// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// SECURITY TEST for the dashboard execution path (POST /api/dashboards/run and
// the MCP run tool → runDashboard → planDashboardRun).
//
// The sibling of restricted-web-query.test.ts, which pins the same property for
// /ltool. Both surfaces accept text from any signed-in caller, and both must
// compile it in core's restricted mode: raw SQL is equivalent to filesystem
// access in DuckDB — read_text/read_blob/glob take absolute paths and run
// in-process — so an open compiler here lets a query read the container's
// environment and secrets.
//
// This file tests the ROUTING, not the compiler. Which compiler a request
// reaches used to depend on whether its text began with `run:`, so a caller
// chose its own compiler by choosing punctuation. The rule is now provenance:
// text the stored manifest declares may run openly (a manifest ships in a
// published repo, pushable only by an owner or admin); text a request supplies
// is restricted. These cases are cheap to assert and the expensive thing to
// rediscover, so they are asserted exhaustively.
//
// Hermetic: pure function, no DB / DuckDB / network.
// Run: npm test   (tsx --test src/lib/**/*.test.ts)

import { test } from "node:test";
import assert from "node:assert/strict";
import { declaredRuns, planDashboardRun } from "./run-plan";

const TILE = "orders -> { aggregate: c is count() }";
const MANIFEST = { title: "D", tiles: [TILE], query: "orders -> { select: id }" };

// The expression the real exploit used: a raw-SQL source reading a file.
const RAW_SQL = `duckdb.sql("select content from read_text('/proc/self/environ')") -> { select: content }`;

test("raw SQL in `query` is routed to the restricted compiler, not the open one", () => {
  const plan = planDashboardRun(MANIFEST, { query: RAW_SQL });
  assert.equal(plan.kind, "restricted");
  // Wrapped so the restricted compiler sees a complete query. The point is the
  // KIND: `declared` would mean it reached the open loader.
  assert.equal(plan.kind === "restricted" && plan.text, `run: ${RAW_SQL}`);
});

test("...and so is raw SQL that spells itself with a leading `run:`", () => {
  // The old rule treated a `run:` prefix as the signal for restricted. Keeping
  // that true is fine; what must not return is the INVERSE — that its absence
  // means unrestricted.
  const plan = planDashboardRun(MANIFEST, { query: `run: ${RAW_SQL}` });
  assert.equal(plan.kind, "restricted");
});

test("an explicit `malloy` field is restricted, as it always was", () => {
  const plan = planDashboardRun(MANIFEST, { malloy: `run: ${RAW_SQL}` });
  assert.equal(plan.kind, "restricted");
});

test("a request that names one of the manifest's own tiles runs it openly", () => {
  const plan = planDashboardRun(MANIFEST, { query: TILE });
  assert.deepEqual(plan, { kind: "declared", run: TILE });
});

test("whitespace differences still match, and the MANIFEST's text is what runs", () => {
  const plan = planDashboardRun(MANIFEST, { query: `  ${TILE}  ` });
  // Not the request's padded copy: a near-match must not contribute a
  // character of what gets compiled.
  assert.deepEqual(plan, { kind: "declared", run: TILE });
});

test("a tile with raw SQL appended is NOT a match — it is request text", () => {
  // The attack a sloppy prefix/substring check would allow.
  const plan = planDashboardRun(MANIFEST, { query: `${TILE} + ${RAW_SQL}` });
  assert.equal(plan.kind, "restricted");
});

test("no request text falls back to the manifest's own query", () => {
  assert.deepEqual(planDashboardRun(MANIFEST, {}), {
    kind: "declared",
    run: "orders -> { select: id }",
  });
});

test("a manifest with nothing to run says so", () => {
  assert.deepEqual(planDashboardRun({ title: "about" }, {}), { kind: "none" });
});

test("declaredRuns is the allow-list: the manifest's query and tiles, nothing else", () => {
  assert.deepEqual(declaredRuns(MANIFEST), ["orders -> { select: id }", TILE]);
  // Non-strings are ignored rather than coerced — a manifest is stored JSON and
  // a number or object in `tiles` must not become runnable text.
  assert.deepEqual(declaredRuns({ query: 1, tiles: [TILE, 2, null, { a: 1 }] }), [TILE]);
  assert.deepEqual(declaredRuns({}), []);
});
