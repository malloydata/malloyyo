// Drift guard for the frame sources' copy of the row-limit notice.
//
// src/shared/row-limit.ts is a hand copy of mcp-engine/src/truncation.ts for
// the same reason src/shared/json-rows.ts is (see json-rows.test.ts): the frame
// source set ships as source and cannot import a workspace package. A static
// site must say "cut" in the same words the dev server and the hosted app do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowLimitTruncation as engineNotice } from '@malloyyo/mcp-engine';
import { rowLimitTruncation as frameNotice } from '../src/shared/row-limit.js';

test('the frame copy of the row-limit notice matches the engine', () => {
  for (const n of [1, 5000, 10_000]) assert.deepEqual(frameNotice(n), engineNotice(n));
});
