// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The core entry is what a host outside malloyyo can use: it must bundle for a
// neutral platform (no Node built-ins: the malloy-duckdb extension runs it in
// QuickJS), and must not reach malloyyo's product modules or help topics.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import { listHelpTopics } from '../src/core';

const PRODUCT = [
  'dataset-meta', 'repo-layout', 'tarball', 'artifacts', 'given-specs',
  'dashboard-tree', 'instance', 'prepare-source', 'mcp-sdk',
  'surfaces/develop', 'product-help', 'content/generated-product',
];

test('core bundles for a neutral platform, without the product modules', async () => {
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
  const inputs = Object.keys(result.metafile.inputs);
  const product = inputs.filter((f) => PRODUCT.some((p) => f === `src/${p}.ts`));
  assert.deepEqual(product, []);
});

test('core help has the Malloy topics and none of malloyyo\'s', () => {
  const names = listHelpTopics();
  assert.ok(names.includes('language/joins'));
  assert.deepEqual(
    names.filter((n) => /^(authoring|dashboards|repo|site)\//.test(n)),
    [],
  );
});
