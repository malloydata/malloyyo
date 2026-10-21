// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// preview_changes: a base commit's files with a working copy's changes laid
// over them, and the repo named by whatever `git remote get-url origin` prints.
// The overlay is strict on purpose — a mismatch means the caller's base is not
// the server's, and previewing something other than the author's copy is worse
// than refusing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { strToU8, strFromU8, unzipSync, zipSync } from "fflate";
import { ArchiveError, OVERLAY_LIMITS, overlayArchive } from "./repo-archive";
import { githubRepoFromRemote } from "./repo-names";

const base = Buffer.from(
  zipSync({
    "malloy-config.json": strToU8("{}"),
    "datasets/a/index.malloy": strToU8("source: a is duckdb.table('a.parquet')"),
    "datasets/a/old.malloy": strToU8("// old"),
  }),
);
const files = (zip: Buffer) =>
  Object.fromEntries(Object.entries(unzipSync(zip)).map(([k, v]) => [k, strFromU8(v)]));

test("changed and added files replace and join the base; deleted ones go", () => {
  const out = files(
    overlayArchive(base, {
      files: { "datasets/a/index.malloy": "source: a is duckdb.table('b.parquet')", "datasets/b/index.malloy": "// new" },
      deleted: ["datasets/a/old.malloy"],
    }),
  );
  assert.deepEqual(Object.keys(out).sort(), ["datasets/a/index.malloy", "datasets/b/index.malloy", "malloy-config.json"]);
  assert.equal(out["datasets/a/index.malloy"], "source: a is duckdb.table('b.parquet')");
});

test("no changes previews the base unchanged", () => {
  assert.deepEqual(files(overlayArchive(base, { files: {}, deleted: [] })), files(base));
});

test("a deletion the base doesn't have means the bases differ: refused", () => {
  assert.throws(() => overlayArchive(base, { files: {}, deleted: ["datasets/a/nope.malloy"] }), ArchiveError);
});

test("unsafe paths, and a path both written and deleted, are refused", () => {
  for (const p of ["../escape.malloy", "/abs.malloy", "datasets/"]) {
    assert.throws(() => overlayArchive(base, { files: { [p]: "x" }, deleted: [] }), ArchiveError, p);
  }
  assert.throws(
    () => overlayArchive(base, { files: { "datasets/a/old.malloy": "x" }, deleted: ["datasets/a/old.malloy"] }),
    ArchiveError,
  );
});

test("the size limits hold, so a whole repo goes through fetch_branch instead", () => {
  const many = Object.fromEntries(Array.from({ length: OVERLAY_LIMITS.files + 1 }, (_, i) => [`f${i}.malloy`, ""]));
  assert.throws(() => overlayArchive(base, { files: many, deleted: [] }), ArchiveError);
  assert.throws(
    () => overlayArchive(base, { files: { "big.malloy": "x".repeat(OVERLAY_LIMITS.bytes + 1) }, deleted: [] }),
    ArchiveError,
  );
});

test("owner/name from every shape a remote comes in", () => {
  for (const remote of [
    "lloydtabb/malloyyo-test",
    "https://github.com/lloydtabb/malloyyo-test",
    "https://github.com/lloydtabb/malloyyo-test.git",
    "git@github.com:lloydtabb/malloyyo-test.git",
    "http://local_proxy@127.0.0.1:41875/git/lloydtabb/malloyyo-test",
    "  https://github.com/lloydtabb/malloyyo-test/  ",
  ]) {
    assert.equal(githubRepoFromRemote(remote), "lloydtabb/malloyyo-test", remote);
  }
  for (const bad of ["malloyyo_test", "", "https://github.com/"]) assert.equal(githubRepoFromRemote(bad), null, bad);
});
