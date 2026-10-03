// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// What `malloyyo publish --repo` sends.
//
// This replaces a hand-written directory walk with a skip list. Both halves of
// that walk cost real data (docs/repo-model-gotchas.md §1), and the two tests
// named for them are the reason this module exists at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { unzipSync } from "fflate";
import { gitArchiveZip } from "../src/gather.js";

/** A git repo on disk. Signing is off: these are throwaway fixtures, and a
    machine configured to sign would otherwise block on a passphrase. */
function repo(files: Record<string, string>, opts: { commit?: boolean } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gitpack-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", "-q", ".");
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  if (opts.commit !== false) {
    git("add", "-A");
    git("commit", "-qm", "fixture");
  }
  return root;
}

const names = (root: string) =>
  Object.keys(unzipSync(new Uint8Array(gitArchiveZip(root).zip)))
    .filter((n) => !n.endsWith("/"))
    .sort();

test("git decides what is in the repo, so an ignored file cannot leak", () => {
  // `malloy-config-local.json` is Malloy's local override — where the REAL
  // credentials go, while the shared file holds {"env": …} refs — and it is
  // gitignored for exactly that reason. The old walker read the filesystem, so
  // gitignore did not save it and it was uploaded. This is not a filename check;
  // the file was never a candidate.
  const root = repo({
    ".gitignore": "malloy-config-local.json\nnode_modules/\n",
    "malloy-config.json": "{}",
    "malloy-config-local.json": '{"password":"hunter2"}',
    "datasets/sales/index.malloy": "source: a is b",
    "node_modules/pkg/index.js": "dep",
  });
  try {
    const out = names(root);
    assert.ok(!out.includes("malloy-config-local.json"), "the credentials file is not sent");
    assert.ok(!out.some((n) => n.startsWith("node_modules/")), "nor is node_modules");
    assert.ok(out.includes("malloy-config.json"), "the shared config still is");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a dataset directory called `docs` is just a dataset", () => {
  // The other half. The old skip list matched by BASENAME at every depth, so
  // `datasets/docs/` was listed by the layout rules, counted in the CLI's own
  // "2 dataset(s): docs, sales", and packed with none of its files — a
  // half-publish that reported success.
  const root = repo({
    "malloy-config.json": "{}",
    "datasets/sales/index.malloy": "source: a is b",
    "datasets/docs/index.malloy": "source: b is c",
    "datasets/dist/index.malloy": "source: c is d",
  });
  try {
    const out = names(root);
    assert.ok(out.includes("datasets/docs/index.malloy"));
    assert.ok(out.includes("datasets/dist/index.malloy"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("uncommitted work still publishes", () => {
  // `gitInfo` reports `dirty` and the publish line prints it, so iterating
  // against a staging instance without committing is a supported workflow. A
  // plain `git archive HEAD` would silently have published something else — which
  // is why this stages into a throwaway index rather than archiving HEAD.
  const root = repo({ "datasets/sales/index.malloy": "source: a is b" });
  try {
    fs.mkdirSync(path.join(root, "datasets/fresh"), { recursive: true });
    fs.writeFileSync(path.join(root, "datasets/fresh/index.malloy"), "source: new is thing");
    fs.writeFileSync(path.join(root, "datasets/sales/index.malloy"), "source: a is EDITED");

    const out = names(root);
    assert.ok(out.includes("datasets/fresh/index.malloy"), "a brand-new dataset is included");
    const zip = unzipSync(new Uint8Array(gitArchiveZip(root).zip));
    assert.match(
      Buffer.from(zip["datasets/sales/index.malloy"]!).toString("utf8"),
      /EDITED/,
      "and an uncommitted edit is the version sent",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("…and the author's own index is left exactly as it was", () => {
  // Staging into GIT_INDEX_FILE is the whole point: publishing must not change
  // what someone has staged.
  const root = repo({ "datasets/sales/index.malloy": "source: a is b" });
  try {
    fs.writeFileSync(path.join(root, "staged.malloy"), "source: s is t");
    fs.writeFileSync(path.join(root, "unstaged.malloy"), "source: u is v");
    const git = (...a: string[]) =>
      execFileSync("git", a, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git("add", "staged.malloy");
    const before = git("status", "--porcelain");

    gitArchiveZip(root);

    assert.equal(git("status", "--porcelain"), before, "nothing moved in or out of the index");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("git's own export-ignore excludes a committed build, and must be anchored", () => {
  // This repo's instructions tell authors to COMMIT docs/ for GitHub Pages, so
  // git tracks it and it ships. The escape hatch is git's own, which is better
  // than another list of ours — but it has the SAME depth-matching footgun the
  // skip list had: an unanchored `docs/` also matches `datasets/docs/`.
  const files = {
    "malloy-config.json": "{}",
    "datasets/sales/index.malloy": "source: a is b",
    "datasets/docs/index.malloy": "source: b is c",
    "docs/assets/chunk.js": "x".repeat(5000),
  };

  const loose = repo({ ...files, ".gitattributes": "docs/ export-ignore\n" });
  try {
    assert.ok(
      !names(loose).includes("datasets/docs/index.malloy"),
      "unanchored, it eats the dataset too — the trap worth knowing about",
    );
  } finally {
    fs.rmSync(loose, { recursive: true, force: true });
  }

  const anchored = repo({ ...files, ".gitattributes": "/docs/ export-ignore\n" });
  try {
    const out = names(anchored);
    assert.ok(!out.some((n) => n.startsWith("docs/")), "the built site is excluded");
    assert.ok(out.includes("datasets/docs/index.malloy"), "and the dataset survives");
  } finally {
    fs.rmSync(anchored, { recursive: true, force: true });
  }
});

test("a repo with no commits yet publishes what is there", () => {
  // `malloyyo init` leaves exactly this, and a first publish before a first
  // commit is an ordinary thing to do.
  const root = repo({ "datasets/sales/index.malloy": "source: a is b" }, { commit: false });
  try {
    assert.deepEqual(names(root), ["datasets/sales/index.malloy"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a directory that is not a git repo says so, and says what to do", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "notgit-"));
  try {
    fs.writeFileSync(path.join(root, "index.malloy"), "source: a is b");
    assert.throws(() => gitArchiveZip(root), /not a git repository[\s\S]*git init/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
