// The repo's written front door: `dashboards/index.jsx|tsx` with no
// `index.malloy`. It is a dashboard that runs no query, discovered by filename
// rather than by a `## artifact` tag — so the rules about WHEN it applies are
// the whole contract, and they are what these tests pin.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { aboutPage, rendersNoData, ABOUT_NAME, ABOUT_TITLE } from '../src/discover.js';
import { gatherDashboards } from '../src/gather.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));

/** A throwaway project root with the given files under dashboards/. */
function withRepo(files: Record<string, string>, fn: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'malloyyo-about-'));
  fs.mkdirSync(path.join(root, 'dashboards'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, 'dashboards', name), content);
  }
  try {
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('index.jsx with no index.malloy is the About page', () => {
  withRepo({ 'index.jsx': 'export default () => null' }, (root) => {
    const about = aboutPage(root);
    assert.ok(about, 'discovered');
    assert.equal(about!.name, ABOUT_NAME);
    assert.equal(about!.title, ABOUT_TITLE);
    assert.equal(about!.query, '', 'runs no query');
    assert.equal(about!.tiles, undefined);
    assert.ok(about!.tsxPath?.endsWith('index.jsx'));
    assert.equal(about!.entryFile, undefined, 'has no .malloy to compile');
    assert.equal(rendersNoData(about!), true);
  });
});

test('.tsx works too', () => {
  withRepo({ 'index.tsx': 'export default () => null' }, (root) => {
    assert.ok(aboutPage(root)?.tsxPath?.endsWith('index.tsx'));
  });
});

test('an index.malloy beside it wins — there is no About page', () => {
  // Then "index" is an ordinary dashboard and index.jsx is its component. Two
  // entries of that name would shadow each other, so this must return null.
  withRepo(
    { 'index.jsx': 'export default () => null', 'index.malloy': '## artifact { title="Index" }' },
    (root) => assert.equal(aboutPage(root), null),
  );
});

test('no landing file, no About page', () => {
  withRepo({ 'other.jsx': 'export default () => null' }, (root) => {
    assert.equal(aboutPage(root), null);
  });
});

test('a missing dashboards/ directory is not an error', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'malloyyo-about-'));
  try {
    assert.equal(aboutPage(root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rendersNoData is false for anything with a query or tiles', () => {
  assert.equal(rendersNoData({ query: 'sales -> totals' }), false);
  assert.equal(rendersNoData({ query: '', tiles: ['sales -> totals'] }), false);
  assert.equal(rendersNoData({ query: '' }), true);
  assert.equal(rendersNoData({ query: '', tiles: [] }), true);
});

test('publish: the About page leads the payloads', async () => {
  const payloads = await gatherDashboards(path.join(here, 'fixtures', 'v2-lint'));
  assert.equal(payloads[0]?.name, ABOUT_NAME, 'front door first');
  assert.equal(payloads[0]?.manifest.title, ABOUT_TITLE);
  // No entryFile / query / tiles: that absence is what marks it as no-data on
  // the server, so it must not acquire any of them on the way through publish.
  assert.deepEqual(Object.keys(payloads[0]!.manifest), ['title']);
  assert.ok(payloads[0]!.source.includes('Landing'), 'the component travels as the source');
});

test('publish: a tag that claims the name "index" beats the About page', async () => {
  // The collision the filename check alone would miss: an artifact's name comes
  // from its `## artifact { name= }` tag, not its filename, so dashboards/
  // intro.malloy can resolve to "index" while dashboards/index.jsx also exists.
  // Publishing both would put two same-named artifacts in one model, and the
  // server has no unique (model_id, name) — getDashboard would then serve
  // whichever row Postgres returned first. The real dashboard wins.
  const payloads = await gatherDashboards(path.join(here, 'fixtures', 'about-collision'));
  const named = payloads.filter((p) => p.name === ABOUT_NAME);
  assert.equal(named.length, 1, 'exactly one artifact answers to "index"');
  assert.equal(named[0]!.manifest.title, 'Intro', 'and it is the real dashboard, not the About page');
});
