// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The core entry is what a host outside malloyyo can use: it must bundle for a
// neutral platform (no Node built-ins: the malloy-duckdb extension runs it in
// QuickJS), reach only the modules listed here, and carry help about Malloy,
// not about malloyyo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import {
  addHelpContent,
  assembleInstructions,
  getHelpTopic,
  guidance,
  listHelpTopics,
  prompts,
} from '../src/core';
import { utf8Length } from '../src/surfaces/budget';

// Every module the core may reach. A module added to this list is a decision
// that it holds nothing malloyyo-specific. (host-givens is the one exception:
// it reserves the MALLOYYO_ prefix for givens a host fills in.)
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

// Node's globals, renamed so a reference to one shows in the bundle's text.
// Help text that mentions them is a string, which define leaves alone.
const NODE_GLOBALS = { Buffer: '__NODE_GLOBAL_Buffer__', process: '__NODE_GLOBAL_process__' };

test('core bundles for a neutral platform and reaches only its own modules', async () => {
  const result = await esbuild.build({
    entryPoints: ['src/core.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    metafile: true,
    define: NODE_GLOBALS,
    external: ['@malloydata/malloy', '@malloydata/malloy/*'],
    logLevel: 'silent',
  });
  const outside = Object.keys(result.metafile.inputs).filter(
    (f) => !CORE_MODULES.includes(f),
  );
  assert.deepEqual(outside, []);
  const globals = result.outputFiles[0]?.text.match(/__NODE_GLOBAL_\w+__/g) ?? [];
  assert.deepEqual([...new Set(globals)], [], 'core uses a Node global');
});

test('utf8Length counts bytes as Buffer does', () => {
  for (const text of ['', 'abc', 'é', '€', '😀', 'a\ud800b', '\udc00', 'x😀é€']) {
    assert.equal(utf8Length(text), Buffer.byteLength(text, 'utf8'), JSON.stringify(text));
  }
});

/** Every string in a nested object, with its path. */
function strings(value: unknown, path: string): Array<[string, string]> {
  if (typeof value === 'string') return [[path, value]];
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([k, v]) => strings(v, `${path}.${k}`));
}

test('core help, prompts and guidance are about Malloy, and every topic they name is in the core', () => {
  const names = listHelpTopics();
  assert.ok(names.includes('language/joins'));
  // yo_help("x"), yo_help('x/y'), `yo_help x/y`: a quoted name, or a bare one with a slash.
  const pointer = /yo_help\(?\s*(?:["'`]([a-z0-9-]+(?:\/[a-z0-9-]+)*)|([a-z0-9-]+(?:\/[a-z0-9-]+)+))/g;
  const texts: Array<[string, string]> = [
    ...names.map((name) => [name, getHelpTopic(name)?.body ?? ''] as [string, string]),
    ...strings(prompts, 'prompts'),
    ...strings(guidance, 'guidance'),
    ['assembleInstructions(explore)', assembleInstructions('explore')],
  ];
  for (const [where, text] of texts) {
    assert.doesNotMatch(text, /malloyyo/i, `${where} mentions malloyyo`);
    for (const [, quoted, bare] of text.matchAll(pointer)) {
      const target = (quoted ?? bare) as string;
      assert.ok(getHelpTopic(target), `${where} points at ${target}, which core does not have`);
    }
  }
});

test('no topic carries its file\'s front matter', () => {
  for (const name of listHelpTopics()) {
    assert.doesNotMatch(getHelpTopic(name)?.body ?? '', /^(---|description:)/, name);
  }
});

// Runs last: it changes the shared index.
test('added content takes its place in the index, and replaces a topic it names', () => {
  const before = listHelpTopics();
  // host/ sorts between the core's explore/ and language/ topics.
  const firstLanguage = before.findIndex((n) => n.startsWith('language/'));
  assert.ok(firstLanguage > 0);
  addHelpContent({
    'host/notes.md': 'Host notes.',
    'explore/how-to.md': 'Replaced.',
  });
  const after = listHelpTopics();
  assert.equal(getHelpTopic('host/notes')?.body, 'Host notes.');
  assert.equal(after.indexOf('host/notes'), firstLanguage);
  assert.deepEqual(after.filter((n) => n !== 'host/notes'), before);
  assert.equal(getHelpTopic('explore/how-to')?.body, 'Replaced.');
});
