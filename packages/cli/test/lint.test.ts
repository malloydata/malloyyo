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

  // The orphaned component (no matching .malloy) is a fatal finding.
  const ghost = byName.get('ghost.jsx');
  assert.ok(ghost, 'orphaned component reported');
  assert.match(ghost!.errors[0], /no matching "ghost\.malloy"/);

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
