// What a component gets from useQuery / runQuery, from each host's raw reply.
// The 5,000-row dashboard cap used to be invisible: rows arrived cut with
// nothing saying so, and a chart of the first 5,000 looked complete.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SingleConnectionRuntime } from '@malloydata/malloy';
import { DuckDBConnection } from '@malloydata/db-duckdb';
import { normalizeRunMessage, truncationNote } from '../src/frame-runtime/run-result.js';
import { rowLimitTruncation } from '../src/shared/row-limit.js';
import { jsonRows } from '../src/shared/json-rows.js';

const notice = rowLimitTruncation(5000);

test('dev server reply (engine RunResult): the notice passes through whole', () => {
  const m = normalizeRunMessage({
    ok: true,
    rows: [{ a: 1 }],
    stable_result: { r: 1 },
    row_count: 5000,
    truncated: notice,
    problems: [],
  });
  assert.equal(m.ok, true);
  assert.deepEqual(m.truncated, notice);
  assert.deepEqual(m.rows, [{ a: 1 }]);
  assert.deepEqual(m.result, { r: 1 });
  assert.equal(m.error, undefined);
});

test('hosted reply: stableResult, and no notice reads as null', () => {
  const m = normalizeRunMessage({ ok: true, rows: [], stableResult: { r: 2 }, rowCount: 0 });
  assert.deepEqual(m.result, { r: 2 });
  assert.equal(m.truncated, null);
});

test('anything but a notice object is not a notice', () => {
  for (const t of [true, 'yes', { reason: 'row_limit' }]) {
    assert.equal(normalizeRunMessage({ ok: true, truncated: t }).truncated, null);
  }
});

test('a failed run still reports its error, uncut', () => {
  const m = normalizeRunMessage({ ok: false, problems: [{ message: 'bad' }, { message: 'worse' }] });
  assert.equal(m.ok, false);
  assert.equal(m.error, 'bad; worse');
  assert.equal(m.truncated, null);
  assert.deepEqual(m.rows, []);
});

test('the viewer-facing note names the rows shown', () => {
  assert.equal(truncationNote(5000), 'Showing the first 5,000 rows; more may exist.');
});

test('static site: 6,000 source rows under a 5,000 limit come back 5,000, with the notice', async () => {
  // The run frame-wasm-entry.tsx makes, on node DuckDB instead of WASM.
  const connection = new DuckDBConnection({ name: 'duckdb' });
  try {
    const runtime = new SingleConnectionRuntime({ connection });
    const result = await runtime
      .loadQuery('run: duckdb.sql("SELECT i FROM range(6000) t(i)") -> { select: i }')
      .run({ rowLimit: 5000 });
    const rows = jsonRows(result);
    const m = normalizeRunMessage({
      ok: true,
      rows,
      stable_result: {},
      truncated: rows.length >= 5000 ? rowLimitTruncation(5000) : undefined,
    });
    assert.equal(m.rows.length, 5000);
    assert.deepEqual(m.truncated, notice);
  } finally {
    await connection.close();
  }
});
