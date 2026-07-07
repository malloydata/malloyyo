import { test } from 'node:test';
import assert from 'node:assert/strict';
import { artifactQueries, dashboardGivenSpecs, run } from '../src/index';
import { fixtureUrl, withFixtureRuntime } from './helpers';

const MODEL = 'artifacts_model.malloy';

test('artifactQueries: discovers both a view artifact and a top-level query artifact', async () => {
  const res = await withFixtureRuntime((rt) => artifactQueries(rt, fixtureUrl(MODEL)));
  assert.equal(res.ok, true);
  if (!res.ok) return;
  // The untagged `everything` view must not be picked up.
  const byName = new Map(res.artifacts.map((a) => [a.name, a]));
  assert.deepEqual([...byName.keys()].sort(), ['at_or_above', 'over-target']);

  const view = byName.get('at_or_above')!;
  assert.equal(view.query, 'nums -> at_or_above'); // run-expression for a view
  assert.equal(view.source, 'nums');
  assert.equal(view.view, 'at_or_above');
  assert.equal(view.title, 'At or above target');
  assert.match(view.description ?? '', /at or above the target/i);

  const q = byName.get('over-target')!;
  assert.equal(q.query, 'above_target'); // run-expression for a top-level query
  assert.equal(q.source, undefined);
  assert.equal(q.view, undefined);
  assert.equal(q.title, 'Above target');
});

test('dashboardGivenSpecs: surfaces a view artifact’s givens through the run: path', async () => {
  const res = await withFixtureRuntime((rt) =>
    dashboardGivenSpecs(rt, fixtureUrl(MODEL), 'nums -> at_or_above'),
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(
    res.givens.map((g) => g.name),
    ['TARGET'],
  );
  const [g] = res.givens;
  assert.ok(g);
  assert.equal(g.type, 'number');
  assert.equal(g.tags?.label, 'Target');
});

test('run: a view artifact by run-expression, binding a given', async () => {
  const res = await withFixtureRuntime((rt) =>
    run(rt, fixtureUrl(MODEL), { runExpr: 'nums -> at_or_above', givens: { TARGET: 2 } }),
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(
    (res.rows as { v: number }[]).map((r) => r.v).sort(),
    [2, 3], // v >= 2
  );
});

test('run: a top-level query artifact by run-expression', async () => {
  const res = await withFixtureRuntime((rt) =>
    run(rt, fixtureUrl(MODEL), { runExpr: 'above_target', givens: { TARGET: 2 } }),
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(
    (res.rows as { v: number }[]).map((r) => r.v),
    [3], // v > 2
  );
});
