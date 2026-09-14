// `.devcontainer/devcontainer.json` is published as an ordinary model file even
// though Malloy never reads it: its presence in the uploaded list is how the
// server knows this repo opens as a working codespace. gatherDirectory skips
// every dotted entry, so reaching past that skip is a deliberate exception —
// and that is what these pin.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gatherDirectory, DEVCONTAINER_PATH } from '../src/gather.js';

/** A throwaway model root with the given files, paths relative to the root. */
function withRepo(files: Record<string, string>, fn: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'malloyyo-gather-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  try {
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('the dev container is published with the model', () => {
  withRepo(
    {
      'index.malloy': 'source: a is _db_.table("t")',
      [DEVCONTAINER_PATH]: '{"image":"ghcr.io/malloydata/malloyyo-devcontainer"}',
    },
    (root) => {
      const { files } = gatherDirectory(root);
      const found = files.find((f) => f.path === DEVCONTAINER_PATH);
      assert.ok(found, 'devcontainer.json is in the payload');
      assert.match(found!.content, /malloyyo-devcontainer/, 'with its contents');
      // POSIX-separated like every other published path, on Windows too.
      assert.ok(!found!.path.includes('\\'), 'posix path');
    },
  );
});

test('a repo without one publishes without one', () => {
  withRepo({ 'index.malloy': 'source: a is _db_.table("t")' }, (root) => {
    const { files } = gatherDirectory(root);
    assert.equal(files.some((f) => f.path === DEVCONTAINER_PATH), false);
    // And the model itself still went up.
    assert.ok(files.some((f) => f.path === 'index.malloy'));
  });
});

test('the rest of .devcontainer/ stays out of the payload', () => {
  // Only the file Codespaces reads without being told where to look is the
  // signal; a Dockerfile beside it is build input we have no use for.
  withRepo(
    {
      'index.malloy': 'source: a is _db_.table("t")',
      '.devcontainer/Dockerfile': 'FROM scratch',
      '.github/workflows/ci.yml': 'name: ci',
    },
    (root) => {
      const { files } = gatherDirectory(root);
      assert.deepEqual(files.map((f) => f.path), ['index.malloy']);
    },
  );
});
