// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The preview address `repo@ref:dataset` is how every route and tool tells a
// branch preview from a published dataset, so these pin what is (and isn't) one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePreviewRef, previewDirOf, previewModelId, previewModelRef, previewRef } from "./repo-preview-refs";

test("repo@ref:dataset splits into its three parts", () => {
  assert.deepEqual(parsePreviewRef("malloyyo_test@try-products:products"), {
    repo: "malloyyo_test",
    ref: "try-products",
    dataset: "products",
  });
  // Branch names keep their slashes; a SHA prefix is just another ref.
  assert.deepEqual(parsePreviewRef("shop@malloyyo/add-orders:orders"), {
    repo: "shop",
    ref: "malloyyo/add-orders",
    dataset: "orders",
  });
  assert.equal(parsePreviewRef("shop@c6de955:orders")?.ref, "c6de955");
});

test("a route segment arrives percent-encoded and still parses", () => {
  assert.deepEqual(parsePreviewRef(encodeURIComponent("shop@malloyyo/add-orders:orders")), {
    repo: "shop",
    ref: "malloyyo/add-orders",
    dataset: "orders",
  });
});

test("published dataset refs are not previews", () => {
  for (const ref of ["products", "malloyyo_test:products", "3f1c2a40-0000-4000-8000-000000000000"]) {
    assert.equal(parsePreviewRef(ref), null, ref);
  }
});

test("malformed addresses are refused rather than guessed at", () => {
  for (const ref of ["@main:orders", "shop@:orders", "shop@main:", "shop@main:a:b"]) {
    assert.equal(parsePreviewRef(ref), null, ref);
  }
});

test("previewRef round-trips through parsePreviewRef", () => {
  const ref = previewRef("shop", "feature/x", "orders");
  assert.equal(ref, "shop@feature/x:orders");
  assert.deepEqual(parsePreviewRef(ref), { repo: "shop", ref: "feature/x", dataset: "orders" });
});

test("a preview cache key names its revision and directory, and nothing else matches", () => {
  const rev = "0b5c3a1e-1234-4abc-8def-0123456789ab";
  const id = previewModelId(rev, "datasets/products");
  assert.equal(previewDirOf(id), "datasets/products");
  assert.deepEqual(previewModelRef(id), { id, source: "", revisionId: rev, datasetId: "" });
  // An ordinary model id — a UUID — is not a preview key.
  assert.equal(previewDirOf(rev), null);
  assert.equal(previewModelRef(rev), null);
  assert.equal(previewDirOf("preview:not-a-uuid:datasets/x"), null);
});
