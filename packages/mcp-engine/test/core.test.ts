// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The core entry is what a host outside malloyyo can use: it must bundle for a
// neutral platform (no Node built-ins: the malloy-duckdb extension runs it in
// QuickJS), reach only the modules listed here, and carry help about Malloy,
// not about malloyyo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import { addHelpContent, getHelpTopic, listHelpTopics } from '../src/core';

// Every module the core may reach. A module added to this list is a decision
// that it holds nothing malloyyo-specific. (host-givens still carries the
// MALLOYYO_ reserved prefix; see the PR that introduced the core.)
const CORE_MODULES = [
  'src/catalog.ts',
  'src/content/generated.ts',
  'src/core.ts',
  'src/guidance.ts',
  'src/help.ts',
  'src/host-givens.ts',
  'src/prettify.ts',
  'src/problems.ts',
  'src/project.ts',
  'src/prompts.ts',
  'src/quoting.ts',
  'src/restricted.ts',
  'src/rows.ts',
  'src/run.ts',
  'src/select.ts',
  'src/surfaces/budget.ts',
  'src/surfaces/explore.ts',
  'src/surfaces/shared.ts',
  'src/truncation.ts',
  'src/types.ts',
  'src/walker.ts',
];

test('core bundles for a neutral platform and reaches only its own modules', async () => {
  const result = await esbuild.build({
    entryPoints: ['src/core.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    metafile: true,
    external: ['@malloydata/malloy', '@malloydata/malloy/*'],
    logLevel: 'silent',
  });
  const outside = Object.keys(result.metafile.inputs).filter(
    (f) => !CORE_MODULES.includes(f),
  );
  assert.deepEqual(outside, []);
});

test('core help is about Malloy, and every topic it names is in it', () => {
  const names = listHelpTopics();
  assert.ok(names.includes('language/joins'));
  const pointer = /yo_help\(?\s*["'`]?([a-z0-9-]+(?:\/[a-z0-9-]+)+)/g;
  for (const name of names) {
    const body = getHelpTopic(name)?.body ?? '';
    assert.doesNotMatch(body, /malloyyo/i, `${name} mentions malloyyo`);
    for (const [, target] of body.matchAll(pointer)) {
      assert.ok(names.includes(target as string), `${name} points at ${target}, which core does not have`);
    }
  }
});

test('added content joins the index without reordering it', () => {
  const before = listHelpTopics();
  addHelpContent({ 'zz-host/notes.md': 'Host notes.' });
  const after = listHelpTopics();
  assert.equal(getHelpTopic('zz-host/notes')?.body, 'Host notes.');
  assert.deepEqual(after.filter((n) => n !== 'zz-host/notes'), before);
});
