// Restricted enforcement: every forbidden construct rejects with
// restricted-construct-forbidden (decorated with the restricted-queries
// help topic), while model-defined capabilities remain fully usable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRestricted, validateRestricted } from '../src/index';
import { fixtureUrl, withFixtureRuntime } from './helpers';

const FLIGHTS = fixtureUrl('flights.malloy');
const GIVENS = fixtureUrl('givens_model.malloy');

// The given: case runs against the givens model — its ##! flag is enabled
// there, so the rejection is the restriction itself, not experiment gating.
const FORBIDDEN: Array<[string, string, URL]> = [
  ['import', 'import "sources.malloy"\nrun: flights -> { aggregate: flight_count }', FLIGHTS],
  ['given declaration', 'given: X :: number is 1\nrun: nums -> { select: v }', GIVENS],
  ['connection.table', 'run: duckdb.table("anything") -> { select: * }', FLIGHTS],
  ['connection.sql', 'run: duckdb.sql("SELECT 1 as x") -> { select: x }', FLIGHTS],
  ['compiler flag', '##! experimental.givens\nrun: flights -> { aggregate: flight_count }', FLIGHTS],
  ['sql_* function', 'run: flights -> { select: x is sql_number("1+1") }', FLIGHTS],
  ['name!type raw-SQL form', 'run: flights -> { select: x is anything!number(distance) }', FLIGHTS],
];

for (const [label, text, model] of FORBIDDEN) {
  test(`restricted rejects ${label}`, async () => {
    const result = await withFixtureRuntime((rt) =>
      validateRestricted(rt, model, text),
    );
    assert.equal(result.ok, false);
    const p = result.problems.find((x) => x.code === 'restricted-construct-forbidden');
    assert.ok(p, `expected restricted-construct-forbidden, got ${JSON.stringify(result.problems)}`);
    assert.equal(p.help_topic, 'explore/restricted-queries');
  });
}

test('restricted reports multiple violations in one compile', async () => {
  const result = await withFixtureRuntime((rt) =>
    validateRestricted(
      rt,
      FLIGHTS,
      'import "sources.malloy"\nrun: duckdb.table("x") -> { select: * }',
    ),
  );
  assert.equal(result.ok, false);
  const forbidden = result.problems.filter(
    (p) => p.code === 'restricted-construct-forbidden',
  );
  assert.ok(
    forbidden.length >= 2,
    `expected ≥2 violations, got ${JSON.stringify(result.problems)}`,
  );
});

test('restricted text may use everything the model defines', async () => {
  const result = await withFixtureRuntime((rt) =>
    validateRestricted(
      rt,
      FLIGHTS,
      `source: long_flights is flights extend { where: distance > 50 }
       run: long_flights -> { group_by: carriers.name; aggregate: total_distance }`,
    ),
  );
  assert.equal(result.ok, true, JSON.stringify(result.problems));
});

test('restricted: running a named query by reference', async () => {
  const result = await withFixtureRuntime((rt) =>
    runRestricted(rt, FLIGHTS, 'run: top_carriers'),
  );
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(result.rows?.length, 2);
});

test('restricted: refining a named query', async () => {
  const result = await withFixtureRuntime((rt) =>
    runRestricted(rt, FLIGHTS, 'run: top_carriers + { limit: 1 }'),
  );
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(result.rows?.length, 1);
});

test('validate reports the givens a query transitively needs, full detail', async () => {
  const result = await withFixtureRuntime((rt) =>
    validateRestricted(rt, GIVENS, 'run: above_target'),
  );
  assert.equal(result.ok, true);
  assert.equal(result.givens?.length, 1);
  const g = result.givens?.[0];
  assert.equal(g?.name, 'TARGET');
  assert.equal(g?.type, 'number');
  assert.equal(g?.has_default, true);
});

test('validate reports no givens for a given-free query', async () => {
  const result = await withFixtureRuntime((rt) =>
    validateRestricted(rt, FLIGHTS, 'run: flights -> { aggregate: flight_count }'),
  );
  assert.equal(result.ok, true);
  assert.equal(result.givens, undefined);
});

test('runRestricted accepts given values', async () => {
  const result = await withFixtureRuntime((rt) =>
    runRestricted(rt, GIVENS, 'run: above_target', { givens: { TARGET: 2 } }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.deepEqual(result.rows, [{ v: 2 }, { v: 3 }]);
});

test('runRestricted uses the declared default when no value supplied', async () => {
  const result = await withFixtureRuntime((rt) =>
    runRestricted(rt, GIVENS, 'run: above_target'),
  );
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(result.rows?.length, 3); // TARGET defaults to 0
});

test('restricted compile errors come back as problems with positions', async () => {
  const result = await withFixtureRuntime((rt) =>
    validateRestricted(rt, FLIGHTS, 'run: flights -> { aggregate: not_a_field }'),
  );
  assert.equal(result.ok, false);
  const p = result.problems.find((x) => x.code === 'field-not-found');
  assert.ok(p);
  assert.equal(typeof p.line, 'number');
});
