import { test } from 'node:test';
import assert from 'node:assert/strict';
import { artifactQueries, dashboardGivenSpecs, modelArtifact, run } from '../src/index';
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
  assert.equal(view.autorun, undefined); // live by default — no flag carried

  const q = byName.get('over-target')!;
  assert.equal(q.query, 'above_target'); // run-expression for a top-level query
  assert.equal(q.source, undefined);
  assert.equal(q.view, undefined);
  assert.equal(q.title, 'Above target');
  assert.equal(q.autorun, false); // `# artifact … autorun=false` → staged/Apply
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

const COMPOSITE = 'composite_artifacts_model.malloy';

test('artifactQueries: discovers model-level ## and source-level # composites', async () => {
  const res = await withFixtureRuntime((rt) => artifactQueries(rt, fixtureUrl(COMPOSITE)));
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const byName = new Map(res.artifacts.map((a) => [a.name, a]));

  // Model-level cross-source composite: tiles pass through verbatim.
  const overview = byName.get('overview')!;
  assert.ok(overview, 'model-level ## artifact composite discovered');
  assert.equal(overview.query, ''); // composite has no single run-expression
  assert.deepEqual(overview.tiles, ['nums -> by_v', 'words -> by_w']);
  assert.equal(overview.dashboard_columns, 3);
  assert.equal(overview.title, 'Overview');

  // Source-level composite: bare tiles resolve to `<source> -> <view>`.
  const words = byName.get('words')!;
  assert.ok(words, 'source-level # artifact composite discovered');
  assert.deepEqual(words.tiles, ['words -> by_w', 'words -> counts']);
  assert.equal(words.source, 'words');
  assert.equal(words.dashboard_columns, undefined); // unset → renderer default
  assert.equal(words.title, 'Words');
});

test('modelArtifact: an inline `query: … # artifact` is a single-QUERY dashboard (not a composite)', async () => {
  const res = await withFixtureRuntime((rt) =>
    modelArtifact(rt, fixtureUrl('dashboard_inline.malloy'), 'dashboard_inline'),
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.ok(res.artifact, 'the tagged inline query is discovered as the file dashboard');
  // A single tagged query stays a single-query artifact: `query` = the run-expression,
  // NO tiles. The frame runs the one query and hands its result straight to the
  // renderer (honoring the query's own `# dashboard`/table/chart tags) — it is NOT
  // wrapped into a one-tile composite (which would nest it inside a dashboard card).
  assert.equal(res.artifact!.query, 'my_dash');
  assert.equal(res.artifact!.tiles, undefined);
  assert.equal(res.artifact!.title, 'Inline Dash');
});

test('modelArtifact: a model-level `## artifact { tiles }` is the composite', async () => {
  const res = await withFixtureRuntime((rt) =>
    modelArtifact(rt, fixtureUrl(COMPOSITE), 'composite_artifacts_model'),
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.ok(res.artifact, 'the model-level ## artifact is discovered');
  assert.deepEqual(res.artifact!.tiles, ['nums -> by_v', 'words -> by_w']);
  assert.equal(res.artifact!.dashboard_columns, 3);
});

test('modelArtifact: a single-tile `## artifact { tiles=[X] }` is a single-query artifact; dashboard_columns is ignored with a warning', async () => {
  const res = await withFixtureRuntime((rt) =>
    modelArtifact(rt, fixtureUrl('single_tile_artifact.malloy'), 'single_tile_artifact'),
  );
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.ok(res.artifact, 'the single-tile artifact is still discovered as a dashboard');
  // Normalized to single-query — identical shape to `# artifact` on a query.
  assert.equal(res.artifact!.query, 'nums -> by_v');
  assert.equal(res.artifact!.tiles, undefined);
  // dashboard_columns is ignored (not carried) and surfaced as a lint warning.
  assert.equal(res.artifact!.dashboard_columns, undefined);
  assert.ok(
    (res.artifact!.warnings ?? []).some((w) => /dashboard_columns/.test(w)),
    'warns that dashboard_columns is ignored on a single-tile artifact',
  );
});
