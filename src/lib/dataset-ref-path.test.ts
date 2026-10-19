// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// A route param arrives encoded under `next dev` and decoded on Vercel; either
// way a dataset address must come back out as ONE path segment — a preview
// labelled with a `claude/<task>` branch included.

import { test } from "node:test";
import assert from "node:assert/strict";
import { datasetRefSegment, plainDatasetRef } from "./dataset-ref-path";

test("encoded or decoded, a slash label becomes one segment", () => {
  const plain = "malloy_imdb@claude/rename-total-votes:movies";
  const encoded = encodeURIComponent(plain);
  assert.equal(datasetRefSegment(plain), encoded);
  assert.equal(datasetRefSegment(encoded), encoded);
  assert.ok(!datasetRefSegment(plain).includes("/"));
});

test("plain refs pass through, and a malformed escape is left alone", () => {
  assert.equal(plainDatasetRef("shop:orders"), "shop:orders");
  assert.equal(plainDatasetRef("shop%3Aorders"), "shop:orders");
  assert.equal(plainDatasetRef("bad%zz"), "bad%zz");
});
