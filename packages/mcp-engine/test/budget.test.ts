// Pure budgeting tests — no DuckDB needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyResultBudget, fitsDescribeBudget, type RunResult } from '../src/index';

function fabricate(rowCount: number, cell: string): RunResult {
  return {
    ok: true,
    sql: 'SELECT 1',
    rows: Array.from({ length: rowCount }, (_, i) => ({ i, cell })),
    row_count: rowCount,
    rows_returned: rowCount,
    problems: [],
  };
}

test('budget: small results pass through untouched', async () => {
  const full = fabricate(5, 'x');
  const out = await applyResultBudget(full, { maxResultBytes: 10_000 }, { toolName: 't', args: {} });
  assert.equal(out.rows?.length, 5);
  assert.equal(out.truncated, undefined);
});

test('budget: oversize results drop whole rows from the end', async () => {
  const full = fabricate(100, 'y'.repeat(50));
  const out = await applyResultBudget(full, { maxResultBytes: 500 }, { toolName: 't', args: {} });
  assert.ok(out.rows!.length > 0 && out.rows!.length < 100);
  assert.equal(out.rows_returned, out.rows!.length);
  assert.equal(out.row_count, 100, 'row_count still reports what the query produced');
  assert.equal(out.truncated?.reason, 'byte_budget');
  assert.ok(out.truncated?.hint.includes('Malloy'));
  // first-N: kept rows are the head, in order
  assert.deepEqual((out.rows as Array<{ i: number }>).map((r) => r.i),
    Array.from({ length: out.rows!.length }, (_, i) => i));
});

test('budget: a single row over budget returns zero rows and names the cause', async () => {
  const full = fabricate(3, 'z'.repeat(5_000));
  const out = await applyResultBudget(full, { maxResultBytes: 500 }, { toolName: 't', args: {} });
  assert.equal(out.rows?.length, 0);
  assert.equal(out.rows_returned, 0);
  assert.ok(out.truncated?.hint.includes('single row'));
});

test('budget: spill receives the FULL result and its uri lands on truncated', async () => {
  const full = fabricate(100, 'w'.repeat(50));
  let spilledRows: number | undefined;
  const out = await applyResultBudget(
    full,
    {
      maxResultBytes: 500,
      spill: async (f) => {
        spilledRows = f.rows?.length;
        return { uri: 'https://example.test/r/abc' };
      },
    },
    { toolName: 't', args: {} },
  );
  assert.equal(spilledRows, 100);
  assert.equal(out.truncated?.full_result, 'https://example.test/r/abc');
});

test('budget: a failing spill never fails the run', async () => {
  const full = fabricate(100, 'v'.repeat(50));
  const out = await applyResultBudget(
    full,
    { maxResultBytes: 500, spill: async () => { throw new Error('disk full'); } },
    { toolName: 't', args: {} },
  );
  assert.equal(out.ok, true);
  assert.equal(out.truncated?.reason, 'byte_budget');
  assert.equal(out.truncated?.full_result, undefined);
});

test('budget: stable_result never travels to the wire', async () => {
  const full = { ...fabricate(2, 'x'), stable_result: { huge: true } };
  const out = await applyResultBudget(full, undefined, { toolName: 't', args: {} });
  assert.equal(out.stable_result, undefined);
});

test('describe budget: size check', () => {
  assert.equal(fitsDescribeBudget({ small: true }, { maxDescribeBytes: 1000 }), true);
  assert.equal(fitsDescribeBudget({ big: 'x'.repeat(2000) }, { maxDescribeBytes: 1000 }), false);
});
