import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/index';
import { fixtureUrl, withFixtureRuntime } from './helpers';

test('run: final run: statement by default', async () => {
  const result = await withFixtureRuntime((rt) =>
    run(rt, fixtureUrl('flights.malloy')),
  );
  assert.equal(result.ok, true);
  assert.ok(result.sql?.toLowerCase().includes('select'));
  assert.equal(result.row_count, 2); // two carriers
  assert.equal(result.rows_returned, 2);
  assert.equal(result.truncated, undefined);
  assert.equal(typeof result.total_time_ms, 'number');
  assert.equal(typeof result.compile_time_ms, 'number');
});

test('run: by name selects a query: definition', async () => {
  const result = await withFixtureRuntime((rt) =>
    run(rt, fixtureUrl('flights.malloy'), { name: 'top_carriers' }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.rows?.length, 2);
});

test('run: by index', async () => {
  const result = await withFixtureRuntime((rt) =>
    run(rt, fixtureUrl('flights.malloy'), { index: 0 }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.rows?.length, 1); // single aggregate row
});

test('run: selector-not-found lists what is available', async () => {
  const result = await withFixtureRuntime((rt) =>
    run(rt, fixtureUrl('flights.malloy'), { name: 'nope' }),
  );
  assert.equal(result.ok, false);
  const p = result.problems[0];
  assert.equal(p?.code, 'selector-not-found');
  assert.ok(p?.message.includes('top_carriers'), 'lists available queries');
});

test('run: selector-out-of-range', async () => {
  const result = await withFixtureRuntime((rt) =>
    run(rt, fixtureUrl('flights.malloy'), { index: 9 }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.problems[0]?.code, 'selector-out-of-range');
});

test('run: no-run when source has no run statement', async () => {
  const result = await withFixtureRuntime((rt) =>
    run(rt, fixtureUrl('sources.malloy')),
  );
  assert.equal(result.ok, false);
  assert.equal(result.problems[0]?.code, 'no-run');
});

test('run: row_limit truncation is reported with a hint', async () => {
  const result = await withFixtureRuntime((rt) =>
    run(rt, fixtureUrl('flights.malloy'), { name: 'top_carriers', rowLimit: 1 }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.rows?.length, 1);
  assert.equal(result.truncated?.reason, 'row_limit');
  // The hint must give actionable recovery, not just mention the product.
  assert.match(result.truncated?.hint ?? '', /aggregate|top-?n|fewer|limit/i);
});

test('run: stableResult attaches the interfaces-format result', async () => {
  const result = await withFixtureRuntime((rt) =>
    run(rt, fixtureUrl('flights.malloy'), { stableResult: true }),
  );
  assert.equal(result.ok, true);
  assert.ok(result.stable_result, 'stable_result populated on request');
  const without = await withFixtureRuntime((rt) =>
    run(rt, fixtureUrl('flights.malloy')),
  );
  assert.equal(without.stable_result, undefined);
});

test('run: retry hook wraps execution', async () => {
  let wrapped = 0;
  const result = await withFixtureRuntime((rt) =>
    run(rt, fixtureUrl('flights.malloy'), {
      retry: async (op) => {
        wrapped++;
        return op();
      },
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(wrapped, 1);
});

test('run: execution failure comes back as problems, not a throw', async () => {
  const result = await withFixtureRuntime((rt) =>
    run(rt, fixtureUrl('bad_field.malloy')),
  );
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.code === 'field-not-found'));
});
