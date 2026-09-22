// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { filterTree, type TreeDataset } from "./dashboard-tree";

const TREE: TreeDataset[] = [
  {
    dataset: "babynames",
    dashboards: [
      { name: "name_explorer", title: "Name explorer" },
      { name: "time-series", title: "Name over Time" },
      { name: "draft-abc", title: "Top Names by Decade", isDraft: true, author: "nick" },
      { name: "draft-def", title: "Names I am watching", isDraft: true, author: "me", mine: true },
    ],
  },
  {
    dataset: "movies",
    dashboards: [
      { name: "genre_pairs", title: "Genre Combinations and Top Titles" },
      { name: "title_detail", title: "Movie Detail" },
    ],
  },
  { dataset: "worldcup", dashboards: [] },
];

test("no query is the whole tree, untouched", () => {
  assert.equal(filterTree(TREE, ""), TREE);
  assert.equal(filterTree(TREE, "   "), TREE);
});

test("a dashboard match keeps only the matching leaves, and drops empty branches", () => {
  const out = filterTree(TREE, "name");
  assert.deepEqual(
    out.map((d) => d.dataset),
    ["babynames"],
  );
  assert.deepEqual(out[0].dashboards.map((d) => d.title), [
    "Name explorer",
    "Name over Time",
    "Top Names by Decade",
    "Names I am watching",
  ]);
});

test("filtering leaves the order alone — the menu sorts drafts itself", () => {
  // The reader's own draft leads the USER DASHBOARDS half (DashboardTree does
  // that sort at render); the filter must not reshuffle what it hands over.
  const out = filterTree(TREE, "babynames");
  assert.deepEqual(out[0].dashboards, TREE[0].dashboards, "same rows, same order");
});

test("a dataset match keeps ALL of its dashboards — you asked for the dataset", () => {
  const out = filterTree(TREE, "movies");
  assert.equal(out.length, 1);
  assert.equal(out[0].dashboards.length, 2, "not just the ones whose titles say 'movies'");
});

test("a dataset with no dashboards is reachable by name, and hidden otherwise", () => {
  assert.deepEqual(
    filterTree(TREE, "worldcup").map((d) => d.dataset),
    ["worldcup"],
  );
  assert.equal(
    filterTree(TREE, "detail").some((d) => d.dataset === "worldcup"),
    false,
  );
});

test("matching ignores case and reads the slug as well as the title", () => {
  assert.equal(filterTree(TREE, "GENRE")[0]?.dashboards[0]?.title, "Genre Combinations and Top Titles");
  // The slug, for someone who knows a dashboard by its URL.
  assert.deepEqual(
    filterTree(TREE, "time-series").map((d) => d.dashboards.map((x) => x.name)),
    [["time-series"]],
  );
});

test("nothing matches is empty, not everything", () => {
  assert.deepEqual(filterTree(TREE, "zzz"), []);
});
