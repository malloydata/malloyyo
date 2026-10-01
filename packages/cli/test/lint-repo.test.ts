// `lintRepo` — the repo is what you validate, because the repo is what
// publishes. A GitHub-backed repo refreshes on a trigger, so this is the last
// moment a human sees an error; it has to have looked at all of it, and it has
// to reach the same verdict about the layout that the server will.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { lintRepo } from '../src/lint.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'v2-lint');

/** Build a throwaway repo from the v2-lint fixture, one copy per dataset. */
function repo(layout: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-repo-'));
  for (const [dest, from] of Object.entries(layout)) {
    const target = dest ? path.join(root, dest) : root;
    fs.mkdirSync(target, { recursive: true });
    fs.cpSync(from, target, { recursive: true });
  }
  return root;
}

test('a single-dataset repo lints exactly as it always did', async () => {
  // Backward compatibility is the requirement, not a nicety: every repo that
  // exists today is this shape, and `lint .` must keep meaning what it meant.
  const r = await lintRepo(FIXTURE);
  assert.equal(r.layoutError, undefined);
  assert.equal(r.datasets.length, 1, 'one dataset: the repo root');
  assert.equal(r.datasets[0].dir, '', 'which is addressed as the root');
  assert.ok(r.datasets[0].report.dashboards.length > 0, 'and its dashboards were linted');
});

test('a multi-dataset repo lints EVERY dataset, and fails if any one does', async () => {
  // The whole point: three clean datasets do not make a clean repo.
  const root = repo({ 'datasets/alpha': FIXTURE, 'datasets/beta': FIXTURE });
  try {
    const r = await lintRepo(root);
    assert.equal(r.layoutError, undefined);
    assert.deepEqual(r.datasets.map((d) => d.dir).sort(), ['datasets/alpha', 'datasets/beta']);
    assert.deepEqual(r.datasets.map((d) => d.name).sort(), ['alpha', 'beta']);
    // The fixture deliberately contains a bad dashboard, so the repo is not ok —
    // and it is not ok because of a dataset, not because of the repo root.
    assert.equal(r.ok, false, 'a failing dataset fails the repo');
    assert.ok(
      r.datasets.every((d) => d.report.dashboards.length > 0),
      'every dataset was actually linted, not just the first',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('BOTH layouts at once is a lint error, before anything is compiled', async () => {
  const root = repo({ 'datasets/alpha': FIXTURE, '': FIXTURE });
  try {
    const r = await lintRepo(root);
    assert.match(r.layoutError ?? '', /both a top-level index\.malloy and a datasets\/ directory/);
    assert.equal(r.ok, false);
    assert.deepEqual(r.datasets, [], 'nothing is linted against a repo we cannot read');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a datasets/ subdirectory with no index.malloy fails, naming it', async () => {
  // Skipping it would lint three of the four datasets someone wrote and report
  // success. The author cannot see the server's logs; the message has to be the
  // whole answer.
  const root = repo({ 'datasets/alpha': FIXTURE });
  fs.mkdirSync(path.join(root, 'datasets', 'scratch'), { recursive: true });
  fs.writeFileSync(path.join(root, 'datasets', 'scratch', 'README.md'), 'notes\n');
  try {
    const r = await lintRepo(root);
    assert.match(r.layoutError ?? '', /datasets\/scratch/);
    assert.match(r.layoutError ?? '', /needs its own index\.malloy/);
    assert.equal(r.ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a directory that is not a repo at all says so', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-repo-empty-'));
  fs.writeFileSync(path.join(root, 'README.md'), '# nothing here\n');
  try {
    const r = await lintRepo(root);
    assert.match(r.layoutError ?? '', /No index\.malloy at the root/);
    assert.equal(r.ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an old single-dataset repo is flagged, not failed", () => {
  // It still publishes. The notice is how someone learns the layout moved on —
  // transitional, and deleted with the rest of the single-dataset support.
  return lintRepo(FIXTURE).then((r) => {
    assert.equal(r.oldLayout, true, "a root index.malloy is the old shape");
    assert.ok(r.datasets.length > 0, "and it is still linted");
  });
});

test("a datasets/ repo is not flagged", async () => {
  const root = repo({ "datasets/alpha": FIXTURE });
  try {
    const r = await lintRepo(root);
    assert.ok(!r.oldLayout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
