// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The archive reader, which is where five bugs lived last time.
//
// The previous implementation hand-rolled a tar reader and writer to avoid a
// dependency. Across three reviews, five bugs were found in them — an
// unbounded gunzip, silent truncation, a dropped ustar prefix, missing path
// sanitisation, and empty members dropped before being recorded — and ALL FIVE
// were in the reader. So the reader is now `fflate` and `tar-stream`, and what
// is tested here is the policy wrapped around them: the limits, the path
// refusals, the GitHub wrapper directory, and the empty-file case that made a
// dataset stop existing.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync, strToU8, zipSync } from "fflate";
import * as tar from "tar-stream";
import {
  ARCHIVE_LIMITS,
  ArchiveError,
  archiveEntryList,
  commonRootPrefix,
  discardWorkspace,
  isSafeMemberPath,
  materializeArchive,
  normalizeArchive,
} from "./repo-archive.js";

function zip(files: Record<string, string | Uint8Array>): Buffer {
  const out: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) out[k] = typeof v === "string" ? strToU8(v) : v;
  return Buffer.from(zipSync(out));
}

/** A `.tar.gz` the way an older `malloyyo` CLI builds one. */
async function targz(files: Record<string, string>): Promise<Buffer> {
  const pack = tar.pack();
  for (const [name, content] of Object.entries(files)) pack.entry({ name }, content);
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const c of pack) chunks.push(Buffer.from(c as Uint8Array));
  return Buffer.from(gzipSync(new Uint8Array(Buffer.concat(chunks))));
}

test("a zip and an older CLI's tar.gz normalize to the same stored archive", async () => {
  // Both ways a repo arrives converge on one format at the door, which is what
  // lets everything after it be one code path instead of a GitHub-shaped
  // ingestion and a CLI-shaped one that agree until they do not.
  const files = { "index.malloy": "source: a is 1\n", "lib/x.malloy": "// shared\n" };
  const fromZip = await normalizeArchive(zip(files));
  const fromTar = await normalizeArchive(await targz(files));
  assert.deepEqual(
    fromTar.entries.map((e) => e.path),
    fromZip.entries.map((e) => e.path),
  );
  // Identical content hashes to the same value, which is what lets a webhook
  // recognise bytes it already serves instead of minting a revision per push.
  assert.equal(fromTar.sha256, fromZip.sha256);
});

test("GitHub's wrapper directory comes off, so one shape reaches the layout rules", async () => {
  const wrapped = zip({
    "malloyyo-babynames-9f8e7d6/index.malloy": "x",
    "malloyyo-babynames-9f8e7d6/dashboards/t.malloy": "y",
  });
  const a = await normalizeArchive(wrapped, { stripWrapper: true });
  assert.deepEqual(
    a.entries.map((e) => e.path),
    ["dashboards/t.malloy", "index.malloy"],
  );
});

test("…and is NOT inferred, because a repo's own datasets/ looks exactly like it", async () => {
  // THE INFERENCE WAS A BUG, and this test is how it was found. A multi-dataset
  // repo holding nothing but `datasets/` has a single shared top-level directory
  // too. Stripping it turned a perfectly good repo into one with no
  // `index.malloy` and no `datasets/`, and a refusal nobody could explain.
  //
  // Both directions, so the fix cannot quietly come undone: the prefix IS there
  // to be found, and it is only removed when the caller says GitHub sent it.
  const files = {
    "datasets/finance/index.malloy": "",
    "datasets/sales/index.malloy": "source: s is 1\n",
  };
  assert.equal(commonRootPrefix(Object.keys(files)), "datasets", "there is a shared prefix");

  const cli = await normalizeArchive(zip(files));
  assert.deepEqual(
    cli.entries.map((e) => e.path).sort(),
    ["datasets/finance/index.malloy", "datasets/sales/index.malloy"],
    "a CLI archive keeps it",
  );

  const stripped = await normalizeArchive(zip(files), { stripWrapper: true });
  assert.deepEqual(
    stripped.entries.map((e) => e.path).sort(),
    ["finance/index.malloy", "sales/index.malloy"],
    "and asking for it removed does remove it",
  );
});

test("a shared prefix is only one when every member shares it", async () => {
  assert.equal(commonRootPrefix(["only/a", "only/b"]), "only");
  assert.equal(commonRootPrefix(["only/a", "top.malloy"]), null);
  assert.equal(commonRootPrefix(["a/x", "b/y"]), null);
  assert.equal(commonRootPrefix([]), null);
});

test("an EMPTY file is kept, because the layout rules key on a file existing", async () => {
  // The old extractor dropped zero-length members before recording them as
  // skipped, so `touch datasets/finance/index.malloy` made that dataset stop
  // existing as far as the server was concerned while `lint` saw it fine.
  const a = await normalizeArchive(
    zip({ "datasets/finance/index.malloy": "", "datasets/finance/dashboards/": new Uint8Array(0) }),
  );
  const entry = a.entries.find((e) => e.path === "datasets/finance/index.malloy");
  assert.ok(entry, "the empty entry file survives");
  assert.equal(entry.isDir, false);
  assert.equal(entry.size, 0);
});

test("…and so is an empty DIRECTORY, so a dataset dir of unread files still exists", async () => {
  // The old archive lister inferred directories only from files it KEPT, so a
  // dataset directory holding only non-kept files did not exist server-side.
  const a = await normalizeArchive(zip({ "datasets/x/": new Uint8Array(0), "index.malloy": "q" }));
  assert.ok(a.entries.some((e) => e.path === "datasets/x" && e.isDir));
});

test("an escaping path is refused, not sanitised", () => {
  // Rewriting a path silently relocates somebody's file, which is how lint and
  // the server come to disagree about what a repo contains.
  for (const bad of ["../etc/passwd", "/abs/path", "a/../../b", "C:/win", "a\\b", "a\0b", ""]) {
    assert.equal(isSafeMemberPath(bad), false, `${JSON.stringify(bad)} must be refused`);
  }
  for (const good of ["index.malloy", "datasets/a/index.malloy", "lib/x.malloy", ".devcontainer/x.json"]) {
    assert.equal(isSafeMemberPath(good), true, `${good} is fine`);
  }
});

test("…and an archive containing one is refused whole", async () => {
  await assert.rejects(
    () => normalizeArchive(zip({ "index.malloy": "x", "../escape.malloy": "y" })),
    (err: unknown) => err instanceof ArchiveError && /unsafe path/.test((err as Error).message),
  );
});

test("a per-file size limit is enforced from the central directory, before inflating", async () => {
  // THE BOMB BOUND. A zip declares each member's uncompressed size up front, so
  // the refusal happens without inflating anything — which is the property that
  // made zip the stored format. `.tar.gz` cannot do this: gzip is one stream.
  const big = "x".repeat(ARCHIVE_LIMITS.maxFileBytes + 1024);
  await assert.rejects(
    () => normalizeArchive(zip({ "index.malloy": "a", "huge.malloy": big })),
    (err: unknown) => err instanceof ArchiveError && /limit for a source file/.test((err as Error).message),
  );
});

test("…but DATA gets its own, larger limit, because a repo may commit what it reads", async () => {
  // The source limit was written about `.malloy` text and applied to everything,
  // so it refused `malloydata/malloyyo-auto-recalls` — an ordinary repo whose
  // model does `table('rows.csv')` against a committed 22.7MB CSV. Measured: that
  // repo is 5.1MB compressed and 22.7MB expanded, inside both the archive and
  // total caps. Only this rule was turning it away.
  const asBigAsThatCsv = "x".repeat(ARCHIVE_LIMITS.maxFileBytes * 3);
  const out = await normalizeArchive(zip({ "index.malloy": "a", "rows.csv": asBigAsThatCsv }));
  assert.ok(
    out.entries.some((e) => e.path === "rows.csv"),
    "the data file is carried",
  );

  // The looser cap is for data only. An unknown extension takes the tight one,
  // which is the safe direction: the tight cap refuses loudly, the loose one is
  // what lets tens of megabytes into the database.
  await assert.rejects(
    () => normalizeArchive(zip({ "index.malloy": "a", "mystery.bin": asBigAsThatCsv })),
    (err: unknown) => err instanceof ArchiveError && /limit for a source file/.test((err as Error).message),
  );

  // And a data file can still be absurd.
  await assert.rejects(
    () =>
      normalizeArchive(
        zip({ "index.malloy": "a", "huge.csv": "x".repeat(ARCHIVE_LIMITS.maxDataFileBytes + 1024) }),
      ),
    (err: unknown) => err instanceof ArchiveError && /limit for a data file/.test((err as Error).message),
  );
});

test("a highly compressible bomb is refused on its DECLARED expanded size", async () => {
  // 64 members of 4MB of zeroes each compress to almost nothing and expand to
  // 256MB. The total cap catches it from the central directory.
  const members: Record<string, Uint8Array> = {};
  for (let i = 0; i < 64; i += 1) members[`f${i}.malloy`] = new Uint8Array(4 * 1024 * 1024);
  const bomb = zip(members);
  assert.ok(bomb.length < 1024 * 1024, "the payload really is tiny");
  await assert.rejects(
    () => normalizeArchive(bomb),
    (err: unknown) => err instanceof ArchiveError && /expands to more than/.test((err as Error).message),
  );
});

test("something that is neither a zip nor a gzip is named, not guessed at", async () => {
  await assert.rejects(
    () => normalizeArchive(Buffer.from("this is not an archive")),
    (err: unknown) => err instanceof ArchiveError && /neither a zip nor a gzipped tar/.test((err as Error).message),
  );
  await assert.rejects(() => normalizeArchive(zip({})), (err: unknown) => err instanceof ArchiveError);
});

test("materializing puts the repo on a real disk, empty files and all", async () => {
  // The whole reason for materializing: every "lint blessed it, the server
  // refused it" bug was an in-memory file map behaving unlike a directory tree.
  const a = await normalizeArchive(
    zip({
      "index.malloy": "source: a is 1\n",
      "datasets/finance/index.malloy": "",
      "lib/x.malloy": "// shared\n",
      "empty_dir/": new Uint8Array(0),
    }),
  );
  const dir = materializeArchive(a.zip, "test");
  try {
    assert.equal(fs.readFileSync(path.join(dir, "index.malloy"), "utf8"), "source: a is 1\n");
    assert.equal(fs.statSync(path.join(dir, "datasets/finance/index.malloy")).size, 0);
    assert.ok(fs.statSync(path.join(dir, "lib/x.malloy")).isFile());
    assert.ok(fs.statSync(path.join(dir, "empty_dir")).isDirectory());
  } finally {
    discardWorkspace(dir);
  }
  assert.equal(fs.existsSync(dir), false, "and it is cleaned up");
});

test("materializing a STORED archive re-checks its paths", async () => {
  // Checked on the way out as well as the way in, so an archive stored before
  // the inbound check existed cannot write outside the temp directory.
  const sneaky = Buffer.from(zipSync({ "../escape.malloy": strToU8("x") }));
  assert.throws(() => materializeArchive(sneaky, "test"), ArchiveError);
});

test("a stored archive's listing can be read back without unpacking it to disk", async () => {
  const a = await normalizeArchive(zip({ "index.malloy": "x", "datasets/b/": new Uint8Array(0) }));
  assert.deepEqual(
    archiveEntryList(a.zip).map((e) => `${e.path}${e.isDir ? "/" : ""}`),
    ["datasets/b/", "index.malloy"],
  );
});

test("discarding a workspace that is already gone is not an error", () => {
  // A leftover temp directory is not an outage, and neither is a missing one.
  discardWorkspace(path.join(os.tmpdir(), "malloyyo-does-not-exist-12345"));
});
