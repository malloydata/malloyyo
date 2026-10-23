// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The web run routes' row-limit bound (security review 2026-10, finding on
// unbounded `maxRows`). Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { clampRowLimit, DEFAULT_WEB_ROWS, MAX_WEB_ROWS } from "./row-limit";

test("an ordinary value passes through", () => {
  assert.equal(clampRowLimit(500), 500);
  assert.equal(clampRowLimit("250"), 250);
});

test("absent or malformed falls back to the default", () => {
  assert.equal(clampRowLimit(undefined), DEFAULT_WEB_ROWS);
  assert.equal(clampRowLimit(null), DEFAULT_WEB_ROWS);
  assert.equal(clampRowLimit("abc"), DEFAULT_WEB_ROWS);
  assert.equal(clampRowLimit(NaN), DEFAULT_WEB_ROWS);
  assert.equal(clampRowLimit(Infinity), DEFAULT_WEB_ROWS);
  assert.equal(clampRowLimit({}), DEFAULT_WEB_ROWS);
});

test("a huge or tiny value is clamped, never passed to the engine", () => {
  assert.equal(clampRowLimit(1_000_000_000), MAX_WEB_ROWS);
  assert.equal(clampRowLimit(0), 1);
  assert.equal(clampRowLimit(-5), 1);
  assert.equal(clampRowLimit(12.9), 12);
});
