// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The layout rules live here, so their tests do too. They were written in the
// server's suite when the rules were there, and did not follow the move.

import test from "node:test";
import assert from "node:assert/strict";
import { layoutFromListing, type DirLister } from '../src/repo-layout';
import type { DirEntry as GitHubDirEntry } from '../src/repo-layout';

// A repo is ONE layout or the other, and every refusal below is one a model
// author has to act on from the message alone — they cannot see this server's
// logs. Exercised against a fake lister so the rules are pinned offline.

const file = (name: string): GitHubDirEntry => ({ name, path: name, type: "file" });
const dir = (name: string): GitHubDirEntry => ({ name, path: name, type: "dir" });

/** A lister over a literal { path: entries } map; unknown paths list empty,
    which is what the Contents API does for a 404. */
function listing(tree: Record<string, GitHubDirEntry[]>): DirLister {
  return async (path: string) => tree[path] ?? [];
}

test("a root index.malloy is a single-dataset repo", async () => {
  const r = await layoutFromListing(
    listing({ "": [file("index.malloy"), dir("dashboards"), file("malloy-config.json")] }),
  );
  assert.equal(r.ok && r.kind, "single");
});

test("datasets/ subdirectories each become a dataset, named after the directory", async () => {
  const r = await layoutFromListing(
    listing({
      "": [dir("datasets"), dir("lib"), file("malloy-config.json")],
      datasets: [dir("finance"), dir("sales")],
      "datasets/finance": [file("index.malloy"), dir("dashboards")],
      "datasets/sales": [file("index.malloy")],
    }),
  );
  assert.equal(r.ok && r.kind, "multi");
  assert.deepEqual(r.ok && r.kind === "multi" ? r.datasets : null, [
    { name: "finance", dir: "datasets/finance" },
    { name: "sales", dir: "datasets/sales" },
  ]);
});

test("a directory name that is not a legal dataset name is slugified", async () => {
  const r = await layoutFromListing(
    listing({
      "": [dir("datasets")],
      datasets: [dir("Auto Recalls")],
      "datasets/Auto Recalls": [file("index.malloy")],
    }),
  );
  assert.deepEqual(r.ok && r.kind === "multi" ? r.datasets : null, [
    { name: "auto_recalls", dir: "datasets/Auto Recalls" },
  ]);
});

test("BOTH layouts at once is refused, not guessed", async () => {
  // Guessing picks one and publishes half of what the author meant, which looks
  // exactly like success.
  const r = await layoutFromListing(
    listing({
      "": [file("index.malloy"), dir("datasets")],
      datasets: [dir("finance")],
      "datasets/finance": [file("index.malloy")],
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error, /both a top-level index\.malloy and a datasets\/ directory/);
});

test("a datasets/ subdirectory with no index.malloy is refused BY NAME", async () => {
  // Skipping it would publish two of the three datasets someone wrote and
  // report success — and the missing one is the one nobody checks.
  const r = await layoutFromListing(
    listing({
      "": [dir("datasets")],
      datasets: [dir("finance"), dir("scratch"), dir("sales")],
      "datasets/finance": [file("index.malloy")],
      "datasets/sales": [file("index.malloy")],
      "datasets/scratch": [file("notes.md")],
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error, /datasets\/scratch/);
  assert.match(r.ok ? "" : r.error, /needs its own index\.malloy/);
});

test("two directories that slugify to one name are refused", async () => {
  // Otherwise which one wins depends on insert order.
  const r = await layoutFromListing(
    listing({
      "": [dir("datasets")],
      datasets: [dir("auto-recalls"), dir("auto_recalls")],
      "datasets/auto-recalls": [file("index.malloy")],
      "datasets/auto_recalls": [file("index.malloy")],
    }),
  );
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error, /both publish a dataset named "auto_recalls"/);
});

test("neither layout, and an empty repo, each say what is missing", async () => {
  const neither = await layoutFromListing(listing({ "": [file("README.md")] }), "o/r@main");
  assert.equal(neither.ok, false);
  assert.match(neither.ok ? "" : neither.error, /No index\.malloy at the root of o\/r@main/);

  const empty = await layoutFromListing(listing({}), "o/r@main");
  assert.equal(empty.ok, false);
  assert.match(empty.ok ? "" : empty.error, /empty or could not be read/);

  const noSubdirs = await layoutFromListing(listing({ "": [dir("datasets")], datasets: [file("README.md")] }));
  assert.equal(noSubdirs.ok, false);
  assert.match(noSubdirs.ok ? "" : noSubdirs.error, /no subdirectories/);
});

