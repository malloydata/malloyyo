// Unit test for `lintDashboards` over a DuckDB fixture (no external connection).
// Structure v2: each dashboard is a `dashboards/<name>.malloy` compiled as its
// own entry. Checks are local and loud — a bad tile / bad columns / orphaned
// component fails lint, at the file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import url from 'node:url';
import { lintDashboards } from '../src/lint.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'v2-lint');

test('lint v2: passes a good dashboard, catches a bad tile, bad columns, and an orphan component', async () => {
  const report = await lintDashboards(FIXTURE);
  const byName = new Map(report.dashboards.map((d) => [d.name, d]));

  // Name = the file basename (the tag sets only `title=`, not `name=`).
  // The good dashboard compiles, its tiles run, columns valid → clean.
  const good = byName.get('good');
  assert.ok(good, 'good dashboard discovered (named by file basename)');
  assert.deepEqual(good!.errors, [], 'good dashboard has no errors');

  // The bad dashboard: an undefined tile AND a non-positive dashboard_columns.
  const bad = byName.get('bad');
  assert.ok(bad, 'bad dashboard discovered');
  assert.ok(
    bad!.errors.some((e) => /dashboard_columns must be a positive integer/.test(e)),
    'flags dashboard_columns=0',
  );
  assert.ok(
    bad!.errors.some((e) => /tile "sales -> nope"/.test(e) && /not defined/.test(e)),
    'flags the undefined tile, naming it',
  );

  // A single-tile `tiles=[X]` is a single-query dashboard: it compiles cleanly,
  // and dashboard_columns is ignored with a WARNING (not an error).
  const single = byName.get('single');
  assert.ok(single, 'single-tile dashboard discovered');
  assert.deepEqual(single!.errors, [], 'single-tile dashboard has no errors');
  assert.ok(
    single!.warnings.some((w) => /dashboard_columns/.test(w)),
    'warns that dashboard_columns is ignored on a single-tile artifact',
  );

  // The orphaned component (no matching .malloy) is a fatal finding.
  const ghost = byName.get('ghost.jsx');
  assert.ok(ghost, 'orphaned component reported');
  assert.match(ghost!.errors[0], /no matching "ghost\.malloy"/);

  // ...but index.jsx is NOT an orphan. It is the static bundle's landing page:
  // plain React with no Malloy and no query BY DESIGN, so there is no
  // index.malloy to match and demanding one blocked publish on a repo that
  // bundled fine. It is still reported, so the author can see it was recognised.
  const landing = byName.get('index.jsx');
  assert.ok(landing, 'landing page reported');
  assert.deepEqual(landing!.errors, [], 'a valid landing page is not an error');

  // Link check: bad.jsx hard-codes query="nope", which doesn't resolve.
  assert.ok(
    bad!.errors.some((e) => /bad\.jsx: query "nope"/.test(e) && /doesn't resolve/.test(e)),
    "flags a component's query= that doesn't resolve in the dashboard scope",
  );

  // Link check: a `# drill { to=[ghosttown] }` targets no dashboard file.
  const drill = byName.get('drill → ghosttown');
  assert.ok(drill, 'unresolved drill target reported');
  assert.match(drill!.errors[0], /targets no dashboard/);

  // Any error fails the whole lint (publish is blocked).
  assert.equal(report.ok, false, 'lint fails when a dashboard has errors');
});

test('lint v2: a landing page alone is publishable, and a broken one still fails', async () => {
  // The bug this covers: `publish` gates on lint, so an unfixable lint error on
  // dashboards/index.jsx meant a repo could be bundled but never published.
  const ok = await lintDashboards(path.join(here, 'fixtures', 'v2-lint'));
  assert.ok(
    ok.dashboards.find((d) => d.name === 'index.jsx'),
    'the landing page is discovered rather than silently skipped',
  );

  // Exempting it from the orphan check must not make it unchecked: it is
  // compiled by `bundle`, so a syntax error should surface at lint time — with
  // the file named — instead of at bundle time.
  const broken = await lintDashboards(path.join(here, 'fixtures', 'v2-landing-broken'));
  assert.equal(broken.ok, false, 'a landing page that cannot parse fails lint');
  const d = broken.dashboards.find((x) => x.name === 'index.jsx');
  assert.ok(d, 'the broken landing page is reported');
  assert.equal(d!.errors.length, 1);
  assert.match(d!.errors[0], /^index\.jsx: /, 'the error names the file');
  // Not the orphan message — that was the wrong diagnosis for this file.
  assert.doesNotMatch(d!.errors[0], /no matching/);
});
