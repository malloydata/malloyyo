// Givens the HOST fills: a tenant identity a caller must not be able to choose.
// The pure merge first, then the same rules through a real compile — the two
// facts the design rests on (a caller's value overlays the runtime layer, and
// supplying an undeclared given is an ERROR, not a no-op) are Malloy's, so
// they are pinned here against real DuckDB rather than assumed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveHostGivens,
  withoutHostGivens,
  dashboardGivenSpecs,
  runRestricted,
  validateRestricted,
  type HostGivens,
} from '../src/index';
import { fixtureUrl, withFixtureRuntime } from './helpers';

const TENANT = fixtureUrl('tenant_model.malloy');
const FLIGHTS = fixtureUrl('flights.malloy');
const HOST: HostGivens = { values: { MALLOYYO_EMAIL: 'a@b.com' }, reservedPrefix: 'MALLOYYO_' };
const DECLARED = new Set(['MALLOYYO_EMAIL', 'REGION']);

test('the host value is bound, and the caller cannot choose it', () => {
  assert.deepEqual(resolveHostGivens({ REGION: 'east' }, HOST, DECLARED), {
    REGION: 'east',
    MALLOYYO_EMAIL: 'a@b.com',
  });
  // The whole point: a caller asking to be someone else is dropped, not merged.
  assert.deepEqual(resolveHostGivens({ MALLOYYO_EMAIL: 'c@d.com' }, HOST, DECLARED), {
    MALLOYYO_EMAIL: 'a@b.com',
  });
});

test('a reserved name the host does not fill is still not the caller\'s to set', () => {
  // Refused at publish, but a model from before that rule must not turn into a
  // caller-settable field that reads as though the server vouched for it.
  const declared = new Set(['MALLOYYO_ROLE']);
  assert.equal(resolveHostGivens({ MALLOYYO_ROLE: 'admin' }, HOST, declared), undefined);
});

test('a model that never declared it is left alone', () => {
  // Supplying it would be an error, not a no-op — so the declaration IS the
  // opt-in, and every other model runs exactly as before.
  assert.deepEqual(resolveHostGivens({ REGION: 'east' }, HOST, new Set(['REGION'])), {
    REGION: 'east',
  });
  assert.equal(resolveHostGivens(undefined, HOST, new Set()), undefined);
  // No host at all (the CLI with no test_givens): the caller's map, untouched.
  assert.deepEqual(resolveHostGivens({ X: 1 }, undefined, new Set()), { X: 1 });
});

test('introspection hides what the host fills', () => {
  const specs = [{ name: 'REGION' }, { name: 'MALLOYYO_EMAIL' }, { name: 'MALLOYYO_ROLE' }];
  assert.deepEqual(withoutHostGivens(specs, HOST), [{ name: 'REGION' }]);
  assert.deepEqual(withoutHostGivens(specs, undefined), specs);
});

test('a query binds the host identity, and a caller cannot override it', async () => {
  await withFixtureRuntime(async (rt) => {
    const mine = await runRestricted(rt, TENANT, 'run: mine', { hostGivens: HOST });
    assert.equal(mine.ok, true, JSON.stringify(mine.problems));
    assert.deepEqual(mine.rows, [{ who: 'a@b.com' }]);

    const impersonate = await runRestricted(rt, TENANT, 'run: mine', {
      givens: { MALLOYYO_EMAIL: 'c@d.com' },
      hostGivens: HOST,
    });
    assert.equal(impersonate.ok, true, JSON.stringify(impersonate.problems));
    assert.deepEqual(impersonate.rows, [{ who: 'a@b.com' }], 'still the asker, not the ask');
  });
});

test('a model without the given runs untouched', async () => {
  await withFixtureRuntime(async (rt) => {
    const r = await runRestricted(rt, FLIGHTS, 'run: flights -> { aggregate: flight_count }', {
      hostGivens: HOST,
    });
    assert.equal(r.ok, true, JSON.stringify(r.problems));
  });
});

test('execute:false does not ask the caller for the identity', async () => {
  await withFixtureRuntime(async (rt) => {
    const v = await validateRestricted(rt, TENANT, 'run: mine', { hostGivens: HOST });
    assert.equal(v.ok, true, JSON.stringify(v.problems));
    assert.equal(v.givens, undefined, 'the only given it needs is one the host fills');

    const both = await validateRestricted(
      rt,
      TENANT,
      'run: rows -> { select: who; where: who = $MALLOYYO_EMAIL and region = $REGION }',
      { hostGivens: HOST },
    );
    assert.deepEqual(both.givens?.map((g) => g.name), ['REGION']);
  });
});

test('a dashboard draws no control for what the host fills', async () => {
  // Found the hard way: the tiles path computed its specs without the filter,
  // so a tenant-scoped dashboard rendered an editable MALLOYYO_EMAIL box that
  // did nothing when typed into.
  await withFixtureRuntime(async (rt) => {
    const both = await dashboardGivenSpecs(
      rt,
      TENANT,
      'rows -> { select: who; where: who = $MALLOYYO_EMAIL and region = $REGION }',
      { hostGivens: HOST },
    );
    assert.equal(both.ok, true, both.ok ? '' : both.error);
    assert.deepEqual(both.ok ? both.givens.map((g) => g.name) : [], ['REGION']);

    // Without a host (the CLI with no test_givens) nothing is hidden.
    const unfiltered = await dashboardGivenSpecs(rt, TENANT, 'mine');
    assert.deepEqual(unfiltered.ok ? unfiltered.givens.map((g) => g.name) : [], ['MALLOYYO_EMAIL']);
  });
});
