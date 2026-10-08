// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The catalog lint: what an author hears about the descriptions list_sources
// will show. Warnings only; the sizes are the ones the authoring help asks for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  catalogDocWarnings,
  MODEL_DESCRIPTION_CHARS,
  SOURCE_DESCRIPTION_CHARS,
} from '../src/catalog';

test('a documented model at the asked-for sizes says nothing', () => {
  assert.deepEqual(
    catalogDocWarnings({
      model_ref: 'm',
      description: 'Sales, as finance reports them.',
      sources: [{ source_ref: 'orders', description: 'One row per order line; revenue and margin.' }],
    }),
    [],
  );
});

test('a missing model description, and a source with none, are each named', () => {
  const w = catalogDocWarnings({ model_ref: 'm', sources: [{ source_ref: 'orders' }] });
  assert.equal(w.length, 2);
  assert.match(w[0]!, /no ##" description/);
  assert.match(w[1]!, /source 'orders' has no #" description/);
});

test('a long source description is told where the rest goes', () => {
  const long = 'x'.repeat(SOURCE_DESCRIPTION_CHARS + 1);
  const [w] = catalogDocWarnings({ model_ref: 'm', description: 'ok', sources: [{ source_ref: 'orders', description: long }] });
  assert.match(w!, new RegExp(`${SOURCE_DESCRIPTION_CHARS + 1} characters`));
  assert.match(w!, /#\(agent\)/);
  assert.match(w!, /documenting-models/);
});

test('a long model description is flagged; at the limit is not', () => {
  const at = catalogDocWarnings({ model_ref: 'm', description: 'x'.repeat(MODEL_DESCRIPTION_CHARS) });
  assert.deepEqual(at, []);
  const over = catalogDocWarnings({ model_ref: 'm', description: 'x'.repeat(MODEL_DESCRIPTION_CHARS + 1) });
  assert.equal(over.length, 1);
  assert.match(over[0]!, /sentence or two/);
});
