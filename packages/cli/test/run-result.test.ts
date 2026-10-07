// What a component gets from useQuery/runQuery, from each host's raw reply.
// The 5,000-row cap used to be invisible: rows arrived cut with nothing saying
// so, and a scatter plot of the first 5,000 looked complete.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SingleConnectionRuntime } from "@malloydata/malloy";
import { DuckDBConnection } from "@malloydata/db-duckdb";
import { normalizeRunMessage, staticRunReply } from "../src/frame-runtime/run-result";
import { jsonRows } from "../src/shared/json-rows";

test("dev server reply (engine RunResult): truncated object → true", () => {
  const m = normalizeRunMessage({
    ok: true,
    rows: [{ a: 1 }],
    stable_result: { r: 1 },
    row_count: 5000,
    rows_returned: 5000,
    truncated: { reason: "row_limit", hint: "aggregate" },
  });
  assert.equal(m.ok, true);
  assert.equal(m.truncated, true);
  assert.deepEqual(m.rows, [{ a: 1 }]);
  assert.deepEqual(m.result, { r: 1 });
  assert.equal(m.error, undefined);
});

test("hosted reply: truncated boolean passes through; absent → false", () => {
  assert.equal(normalizeRunMessage({ ok: true, rows: [], stableResult: {}, truncated: true }).truncated, true);
  assert.equal(normalizeRunMessage({ ok: true, rows: [], stableResult: {} }).truncated, false);
});

test("a failed run still reports its error", () => {
  const m = normalizeRunMessage({ ok: false, problems: [{ message: "bad" }, { message: "worse" }] });
  assert.equal(m.ok, false);
  assert.equal(m.error, "bad; worse");
  assert.equal(m.truncated, false);
  assert.deepEqual(m.rows, []);
});

test("static site reply: a full page of rows reads as truncated", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));
  assert.equal(normalizeRunMessage(staticRunReply(rows(5000), {}, 5000)).truncated, true);
  assert.equal(normalizeRunMessage(staticRunReply(rows(4999), {}, 5000)).truncated, false);
  assert.equal(normalizeRunMessage(staticRunReply([], {}, 5000)).truncated, false);
});

test("static site: 6,000 source rows under a 5,000 limit → 5,000 rows, truncated", async () => {
  // The same run frame-wasm-entry.tsx makes, on node DuckDB instead of WASM.
  const connection = new DuckDBConnection({ name: "duckdb" });
  try {
    const runtime = new SingleConnectionRuntime({ connection });
    const result = await runtime
      .loadQuery('run: duckdb.sql("SELECT i FROM range(6000) t(i)") -> { select: i }')
      .run({ rowLimit: 5000 });
    const m = normalizeRunMessage(staticRunReply(jsonRows(result), {}, 5000));
    assert.equal(m.rows.length, 5000);
    assert.equal(m.truncated, true);
  } finally {
    await connection.close();
  }
});
