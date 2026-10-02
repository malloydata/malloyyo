// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import "./unit-test-env";
import test from "node:test";
import assert from "node:assert/strict";
import { layoutFromListing, repoPath, rerootFiles } from "./repo-layout";
import { dirFromTree, type GitHubDirEntry } from "./github";

// The SERVER's side of the layout: re-rooting a dataset's files, and reading a
// repo's shape from a GitHub tree. The rules themselves are the engine's and are
// tested there (packages/mcp-engine/test/repo-layout.test.ts) — these are the
// bindings that feed them.

// ── re-rooting ──────────────────────────────────────────────────────────────

test("repoPath: null and empty are the repo root", () => {
  assert.equal(repoPath(null, "index.malloy"), "index.malloy");
  assert.equal(repoPath("", "index.malloy"), "index.malloy");
  assert.equal(repoPath("datasets/finance", "index.malloy"), "datasets/finance/index.malloy");
  assert.equal(repoPath("/datasets/finance/", "dashboards"), "datasets/finance/dashboards");
});

test("rerootFiles: the dataset's directory becomes the model root", () => {
  // What is stored has to be indistinguishable from a single-dataset repo's,
  // because every consumer of a stored model assumes it is rooted at
  // index.malloy.
  const r = rerootFiles(
    new Map([
      ["datasets/finance/index.malloy", "A"],
      ["datasets/finance/dashboards/spend.malloy", "B"],
      ["lib/orders.malloy", "C"],
    ]),
    "datasets/finance",
  );
  assert.equal(r.ok, true);
  assert.deepEqual(
    r.ok ? [...r.files.keys()].sort() : null,
    ["dashboards/spend.malloy", "index.malloy", "lib/orders.malloy"],
  );
  // The shared file keeps its repo-root path, which is exactly what
  // `import "../../lib/orders.malloy"` resolves to from the re-rooted entry —
  // URL resolution clamps `..` at the root.
  assert.equal(r.ok ? r.files.get("lib/orders.malloy") : null, "C");
});

test("rerootFiles: a null dir passes everything through untouched", () => {
  const files = new Map([["index.malloy", "A"], ["dashboards/x.malloy", "B"]]);
  const r = rerootFiles(files, null);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok ? [...r.files.keys()] : null, ["index.malloy", "dashboards/x.malloy"]);
});

test("rerootFiles: a path that would hide another is refused", () => {
  // `datasets/finance/lib/util.malloy` and a root `lib/util.malloy` both land on
  // `lib/util.malloy`, and whichever was written second would silently win.
  const r = rerootFiles(
    new Map([
      ["datasets/finance/index.malloy", "A"],
      ["datasets/finance/lib/util.malloy", "B"],
      ["lib/util.malloy", "C"],
    ]),
    "datasets/finance",
  );
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error, /lib\/util\.malloy/);
  assert.match(r.ok ? "" : r.error, /one would hide the other/);
});

test("rerootFiles: URL resolution really does clamp `..` at the root", () => {
  // The assumption the whole re-rooting rests on, measured rather than assumed:
  // a re-rooted entry importing ../../lib/x.malloy must resolve to the same path
  // the shared file is stored under.
  assert.equal(
    new URL("../../lib/orders.malloy", "file:///index.malloy").pathname.replace(/^\//, ""),
    "lib/orders.malloy",
  );
  // …and from where the file actually sits in the repo, it means the same thing.
  assert.equal(
    new URL("../../lib/orders.malloy", "file:///datasets/finance/index.malloy").pathname.replace(/^\//, ""),
    "lib/orders.malloy",
  );
});

// ── the whole-repo tree ──────────────────────────────────────────────────────

test("dirFromTree: direct children only, at any depth", () => {
  // Discovery reads the repo in one request and slices it per directory. If this
  // returned descendants rather than children, `datasets/` would look like it
  // held every file in every dataset.
  const tree: GitHubDirEntry[] = [
    { name: "malloy-config.json", path: "malloy-config.json", type: "file" },
    { name: "datasets", path: "datasets", type: "dir" },
    { name: "finance", path: "datasets/finance", type: "dir" },
    { name: "index.malloy", path: "datasets/finance/index.malloy", type: "file" },
    { name: "dashboards", path: "datasets/finance/dashboards", type: "dir" },
    { name: "spend.malloy", path: "datasets/finance/dashboards/spend.malloy", type: "file" },
  ];
  assert.deepEqual(dirFromTree(tree, "").map((e) => e.name).sort(), ["datasets", "malloy-config.json"]);
  assert.deepEqual(dirFromTree(tree, "datasets").map((e) => e.name), ["finance"]);
  assert.deepEqual(
    dirFromTree(tree, "datasets/finance").map((e) => e.name).sort(),
    ["dashboards", "index.malloy"],
  );
  assert.deepEqual(dirFromTree(tree, "datasets/finance/dashboards").map((e) => e.name), ["spend.malloy"]);
  assert.deepEqual(dirFromTree(tree, "nope"), []);
});

test("dirFromTree: a prefix that only looks like a directory does not match", () => {
  // `datasets_old/x` must not be read as a child of `datasets`.
  const tree: GitHubDirEntry[] = [
    { name: "datasets", path: "datasets", type: "dir" },
    { name: "x", path: "datasets_old/x", type: "file" },
    { name: "y", path: "datasets/y", type: "file" },
  ];
  assert.deepEqual(dirFromTree(tree, "datasets").map((e) => e.name), ["y"]);
});

test("the layout rules give the same answer from a tree as from directory walks", () => {
  // The fallback path must not be a different feature.
  const tree: GitHubDirEntry[] = [
    { name: "datasets", path: "datasets", type: "dir" },
    { name: "sales", path: "datasets/sales", type: "dir" },
    { name: "index.malloy", path: "datasets/sales/index.malloy", type: "file" },
  ];
  return layoutFromListing(async (p) => dirFromTree(tree, p)).then((r) => {
    assert.deepEqual(r.ok && r.kind === "multi" ? r.datasets : null, [
      { name: "sales", dir: "datasets/sales" },
    ]);
  });
});
