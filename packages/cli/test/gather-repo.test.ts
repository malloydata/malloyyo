// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// `gatherRepoFiles` — what `publish --repo` packs into the archive.
//
// `gatherDirectory`, which this grew out of, filtered to `*.malloy`, so a
// committed static site could never get into a publish. This one keeps every
// extension the extractor keeps (`keepsFile`), `.js` included — and this repo's
// own instructions tell authors to COMMIT `docs/` so GitHub Pages can serve it.
// The result was a two-dashboard repo packing 7MB of emitted bundle JavaScript,
// which is a request-body limit the author cannot diagnose.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gatherRepoFiles, gatherDirectory } from "../src/gather.js";
import { repoRootOf } from "../src/repo.js";

/** A repo, written from a path → contents map. */
function repo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gather-repo-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return root;
}

const SOURCES = {
  "malloy-config.json": '{ "connections": { "duckdb": { "is": "duckdb" } } }',
  "datasets/sales/index.malloy": "source: a is duckdb.sql('select 1 as x')",
  "datasets/sales/dashboards/overview.malloy": 'import "../index.malloy"',
  "datasets/sales/dashboards/overview.jsx": "export default () => null;",
  "README.md": "# repo",
};

test("the repo's own files are packed, built output is not", () => {
  const root = repo({
    ...SOURCES,
    // A committed GitHub Pages site, which is what the docs tell authors to do.
    "docs/index.html": "<html></html>",
    "docs/assets/model-files.js": "window.x=1",
    "docs/assets/chunk-ABC123.js": "x".repeat(50_000),
    "node_modules/pkg/index.js": "dep",
  });
  try {
    const out = gatherRepoFiles(root);
    assert.deepEqual([...out.keys()].sort(), Object.keys(SOURCES).sort());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a directory is judged by what it holds, never by being called dist/", () => {
  // This cuts both ways on purpose. An earlier version of this file asserted
  // that `dist/thing.js` was dropped, which is what skipping by NAME bought —
  // and what that cost was `datasets/dist/index.malloy`, a real dataset, going
  // silently unpublished. Wrongly keeping a file wastes bytes; wrongly dropping
  // one ships a model that does not work, so the ambiguous case is kept.
  const bare = repo({ ...SOURCES, "dist/thing.js": "could be anything" });
  try {
    assert.ok(gatherRepoFiles(bare).has("dist/thing.js"), "no marker, no guess");
  } finally {
    fs.rmSync(bare, { recursive: true, force: true });
  }

  const emitted = repo({
    ...SOURCES,
    "dist/assets/model-files.js": "window.x=1",
    "dist/assets/chunk-A.js": "x".repeat(50_000),
  });
  try {
    assert.ok(
      ![...gatherRepoFiles(emitted).keys()].some((k) => k.startsWith("dist/")),
      "a bundle is recognised wherever it sits",
    );
  } finally {
    fs.rmSync(emitted, { recursive: true, force: true });
  }
});

test("an emitted site is skipped wherever `-o` put it, not just in docs/", () => {
  // `dashboard bundle -o site` is ordinary, and nothing persists the choice —
  // so a name list cannot be the whole rule. The bundler's own marker file is.
  const root = repo({
    ...SOURCES,
    "site/index.html": "<html></html>",
    "site/assets/model-files.js": "window.x=1",
    "site/assets/chunk-ABC123.js": "x".repeat(50_000),
  });
  try {
    const out = gatherRepoFiles(root);
    assert.deepEqual([...out.keys()].sort(), Object.keys(SOURCES).sort());
    assert.ok(
      ![...out.keys()].some((k) => k.startsWith("site/")),
      "recognised by what the bundler wrote into it",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a directory that merely has an assets/ folder is still the repo's", () => {
  // The marker is `assets/model-files.js`, not `assets/` — a dataset may well
  // keep its own assets, and skipping those would drop real model files.
  const root = repo({
    ...SOURCES,
    "datasets/sales/assets/notes.md": "mine",
    "datasets/sales/assets/extra.malloy": "source: b is a",
  });
  try {
    const out = gatherRepoFiles(root);
    assert.ok(out.has("datasets/sales/assets/extra.malloy"));
    assert.ok(out.has("datasets/sales/assets/notes.md"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── Where the repo root is ──────────────────────────────────────────────────

test("a dataset directory's repo root is the repo, on evidence not on the name", () => {
  const root = repo({
    "malloy-config.json": "{}",
    "datasets/alpha/index.malloy": "",
  });
  try {
    const ds = path.join(root, "datasets", "alpha");
    assert.equal(repoRootOf(ds), root, "the shared config is the evidence");
    assert.equal(repoRootOf(root), root, "and a root is its own root");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a repo that merely LIVES under a directory called datasets is its own root", () => {
  // `~/work/datasets/thing` is an ordinary checkout. Walking up out of it would
  // point the config search at whatever `~/work` happens to contain.
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-repo-"));
  try {
    const mine = path.join(outer, "datasets", "thing");
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, "index.malloy"), "");
    // Nothing above says "repo": no .git, no shared config.
    assert.equal(repoRootOf(mine), mine);
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

// ── Skipping by NAME, and what it cost ──────────────────────────────────────
//
// `docs` and `dist` were in SKIP_DIRS for one release. The set is matched by
// basename at every depth, and nothing else in the system excludes those names,
// so each of these lost real files that the layout rules and the lint could both
// still see.

test("a dataset legitimately named `docs` is packed like any other", () => {
  // The worst of the three: layoutFromListing lists it, the CLI prints
  // "2 dataset(s): docs, sales" from that layout, and the archive carried none
  // of its files — a half-publish reporting success.
  const root = repo({
    "malloy-config.json": '{ "connections": { "duckdb": { "is": "duckdb" } } }',
    "datasets/sales/index.malloy": "source: a is duckdb.sql('select 1 as x')",
    "datasets/docs/index.malloy": "source: b is duckdb.sql('select 1 as x')",
    "datasets/dist/index.malloy": "source: c is duckdb.sql('select 1 as x')",
  });
  try {
    const out = gatherRepoFiles(root);
    assert.ok(out.has("datasets/docs/index.malloy"), "datasets/docs is a dataset");
    assert.ok(out.has("datasets/dist/index.malloy"), "so is datasets/dist");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a dataset's own docs/ subdirectory keeps its models", () => {
  const root = repo({
    "malloy-config.json": "{}",
    "datasets/sales/index.malloy": 'import "docs/shared.malloy"',
    "datasets/sales/docs/shared.malloy": "source: shared is duckdb.sql('select 1 as x')",
  });
  try {
    assert.ok(gatherRepoFiles(root).has("datasets/sales/docs/shared.malloy"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a single-dataset repo importing from docs/ still sends what it imports", () => {
  // gatherDirectory is the legacy single-dataset walker; it skipped neither name
  // before, and skipping them sent the server a model whose import target was
  // missing — compiles here, fails there.
  const root = repo({
    "index.malloy": 'import "docs/shared.malloy"',
    "docs/shared.malloy": "source: shared is duckdb.sql('select 1 as x')",
    "dist/other.malloy": "source: other is duckdb.sql('select 1 as x')",
  });
  try {
    const paths = gatherDirectory(root).files.map((f) => f.path).sort();
    assert.deepEqual(paths, ["dist/other.malloy", "docs/shared.malloy", "index.malloy"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an emitted site in docs/ is still skipped — by what it holds, not its name", () => {
  // The bug the names were reaching for. The marker is depth- and name-agnostic.
  const root = repo({
    "index.malloy": "source: a is duckdb.sql('select 1 as x')",
    "docs/index.html": "<html></html>",
    "docs/assets/model-files.js": "window.x=1",
    "docs/assets/chunk-A.js": "x".repeat(50_000),
  });
  try {
    assert.deepEqual([...gatherRepoFiles(root).keys()], ["index.malloy"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a repo cloned into a directory called `datasets` is its own root", () => {
  // repoRootOf never looked at the directory it was given, so a self-contained
  // model repo at ~/work/datasets/mymodel was declared a dataset of ~/work and
  // became unpublishable — while the advice it printed would have published the
  // unrelated container above it under this repo's name.
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "outer-"));
  try {
    fs.mkdirSync(path.join(outer, ".git"), { recursive: true });
    const mine = path.join(outer, "datasets", "mymodel");
    fs.mkdirSync(path.join(mine, ".git"), { recursive: true });
    fs.writeFileSync(path.join(mine, "index.malloy"), "");
    fs.writeFileSync(path.join(mine, "malloy-config.json"), "{}");
    assert.equal(repoRootOf(mine), mine, "its own checkout wins over the name above it");
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test("…and a worktree or submodule, where .git is a FILE, counts the same", () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "outer2-"));
  try {
    fs.mkdirSync(path.join(outer, ".git"), { recursive: true });
    const mine = path.join(outer, "datasets", "mymodel");
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, ".git"), "gitdir: /elsewhere/.git/worktrees/mymodel\n");
    assert.equal(repoRootOf(mine), mine);
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test("a real dataset directory still resolves to the repo above it", () => {
  // The case repoRootOf exists for must keep working: no .git of its own.
  const root = repo({ "malloy-config.json": "{}", "datasets/alpha/index.malloy": "" });
  try {
    assert.equal(repoRootOf(path.join(root, "datasets", "alpha")), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a local config override is never uploaded — it is where real secrets live", () => {
  // malloy-config-local.json is Malloy's local override. It holds the actual
  // credentials while the shared file holds {"env": …} refs, and it is usually
  // gitignored — but this walker reads the filesystem, not git.
  const root = repo({
    ...SOURCES,
    "malloy-config-local.json": '{ "connections": { "wh": { "password": "hunter2" } } }',
  });
  try {
    const out = gatherRepoFiles(root);
    assert.ok(!out.has("malloy-config-local.json"), "not packed");
    assert.ok(out.has("malloy-config.json"), "the shared one still is");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
