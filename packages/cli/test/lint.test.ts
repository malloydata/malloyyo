// Unit test for `lintDashboards` over a DuckDB fixture (no external connection).
// Focus: the "given referenced but not re-exported from index.malloy" warning —
// a dashboard filtering on such a given still compiles/runs, but its control
// never surfaces from the entry, so the box silently won't render.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import url from 'node:url';
import { lintDashboards } from '../src/lint.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'unexported-given');

test('lint warns when a dashboard filters on a given index.malloy does not export', async () => {
  const report = await lintDashboards(FIXTURE);

  // The warning is non-fatal — it must not fail lint (publish stays unblocked).
  assert.equal(report.ok, true, 'warnings must not fail lint');

  const byName = new Map(report.dashboards.map((d) => [d.name, d]));

  // hidden_dash filters on HIDDEN (declared in model.malloy, NOT re-exported by
  // index.malloy) → one warning naming HIDDEN, and no errors.
  const hidden = byName.get('hidden_dash');
  assert.ok(hidden, 'hidden_dash was discovered as an artifact');
  assert.deepEqual(hidden!.errors, [], 'hidden_dash still compiles/runs (no error)');
  assert.equal(hidden!.warnings.length, 1, 'exactly one warning');
  assert.match(hidden!.warnings[0], /HIDDEN/, 'warning names the offending given');
  assert.match(hidden!.warnings[0], /index\.malloy/, 'warning points at index.malloy');

  // shown_dash filters on SHOWN, which IS re-exported → clean, no warning.
  const shown = byName.get('shown_dash');
  assert.ok(shown, 'shown_dash was discovered as an artifact');
  assert.deepEqual(shown!.errors, [], 'shown_dash has no errors');
  assert.deepEqual(shown!.warnings, [], 'shown_dash has no warnings (SHOWN is exported)');
});
