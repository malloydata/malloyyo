// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The two facts every surface has to agree on: how to recognise a page that
// renders no data, and that the About page leads the list. The second one is
// load-bearing in a way that is easy to miss — the dataset switcher and the home
// page both link to a dataset's FIRST dashboard, so this ordering is the whole
// mechanism behind "switch datasets and land on the introduction".

import { test } from "node:test";
import assert from "node:assert/strict";
import { ABOUT_NAME, ABOUT_TITLE, rendersNoData, aboutFirst } from "./about";

test("a manifest with neither query nor tiles renders no data", () => {
  assert.equal(rendersNoData({ title: ABOUT_TITLE }), true);
  assert.equal(rendersNoData({}), true);
});

test("a real dashboard does not", () => {
  assert.equal(rendersNoData({ query: "sales -> by_state" }), false);
  assert.equal(rendersNoData({ tiles: ["sales -> by_state", "sales -> totals"] }), false);
  // A composite carries query:"" AND tiles — the tiles are what make it real.
  assert.equal(rendersNoData({ query: "", tiles: ["sales -> totals"] }), false);
});

test("empty-but-present query/tiles still count as no data", () => {
  // gather only writes `query` when non-empty, so this is defensive: an empty
  // string or an empty array has nothing to run, and asking the engine to
  // introspect it would compile the model to learn nothing.
  assert.equal(rendersNoData({ query: "" }), true);
  assert.equal(rendersNoData({ tiles: [] }), true);
  assert.equal(rendersNoData({ query: "", tiles: [] }), true);
});

test("a non-string query is not a query", () => {
  // The manifest is untrusted JSON out of Postgres.
  assert.equal(rendersNoData({ query: 42 }), true);
  assert.equal(rendersNoData({ query: null }), true);
  assert.equal(rendersNoData({ tiles: "sales -> totals" }), true);
});

test("aboutFirst puts the About page at the head", () => {
  const rows = [{ name: "alpha" }, { name: ABOUT_NAME }, { name: "zulu" }];
  assert.deepEqual(aboutFirst(rows).map((r) => r.name), [ABOUT_NAME, "alpha", "zulu"]);
});

test("aboutFirst beats alphabetical order, which is the point", () => {
  // "aardvark" sorts before "index", so a name sort alone would hand the front
  // door to whichever dashboard happened to sort first.
  const rows = [{ name: "aardvark" }, { name: ABOUT_NAME }];
  assert.equal(aboutFirst(rows)[0].name, ABOUT_NAME);
});

test("aboutFirst leaves the rest in the order it was given", () => {
  // The caller sorts by name; that ordering has to survive underneath.
  const rows = [{ name: "b" }, { name: "a" }, { name: "c" }];
  assert.deepEqual(aboutFirst(rows).map((r) => r.name), ["b", "a", "c"]);
});

test("aboutFirst is a no-op when there is no About page", () => {
  const rows = [{ name: "a" }, { name: "b" }];
  assert.deepEqual(aboutFirst(rows).map((r) => r.name), ["a", "b"]);
});
