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
import { gatherRepoFiles } from "../src/gather.js";
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
    "dist/thing.js": "built",
    "node_modules/pkg/index.js": "dep",
  });
  try {
    const out = gatherRepoFiles(root);
    assert.deepEqual([...out.keys()].sort(), Object.keys(SOURCES).sort());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
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
