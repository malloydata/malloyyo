// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync, gunzipSync } from "node:zlib";
import { archiveEntries, ArchiveURLReader, buildTarGz, extractTarGz } from '../src/tarball';

// The repo arrives as ONE archive — from GitHub, and (soon) from the CLI. The
// parser is hand-written rather than a dependency, so the formats GitHub
// actually emits are pinned here: ustar, the `prefix` field for long paths, GNU
// long names, and pax extended headers. Verified once by hand against a real
// tarball of lloydtabb/malloyyo_examples; this is what keeps it true.

const BLOCK = 512;

function octal(n: number, len: number): string {
  return n.toString(8).padStart(len - 1, "0") + "\0";
}

/** One tar entry: a 512-byte header with a correct checksum, then padded data. */
function entry(name: string, body: string, opts: { type?: string; prefix?: string } = {}): Buffer {
  const h = Buffer.alloc(BLOCK, 0);
  h.write(name.slice(0, 100), 0, "utf8");
  h.write(octal(0o644, 8), 100, "utf8");
  h.write(octal(0, 8), 108, "utf8");
  h.write(octal(0, 8), 116, "utf8");
  h.write(octal(Buffer.byteLength(body), 12), 124, "utf8");
  h.write(octal(0, 12), 136, "utf8");
  h.write("        ", 148, "utf8"); // checksum field is spaces while summing
  h.write(opts.type ?? "0", 156, "utf8");
  h.write("ustar\0", 257, "utf8");
  h.write("00", 263, "utf8");
  if (opts.prefix) h.write(opts.prefix, 345, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 8), 148, "utf8");

  const data = Buffer.from(body, "utf8");
  const pad = Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK, 0);
  return Buffer.concat([h, data, pad]);
}

function tarball(...entries: Buffer[]): Buffer {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(BLOCK * 2, 0)]));
}

test("a wrapped repo whose only content is datasets/ still unwraps correctly", () => {
  // Both hazards at once: a GitHub wrapper AROUND a repo whose sole top-level
  // entry is `datasets/`. One strip, not two.
  const t = extractTarGz(
    tarball(
      entry("owner-repo-abc123/datasets/a/index.malloy", "a"),
      entry("owner-repo-abc123/datasets/b/index.malloy", "b"),
    ),
  );
  assert.deepEqual(
    [...t.files.keys()].sort(),
    ["datasets/a/index.malloy", "datasets/b/index.malloy"],
  );
});

test("a GitHub-shaped archive comes out repo-relative", () => {
  // GitHub wraps everything in `{owner}-{repo}-{sha}/`. A CLI-built archive may
  // not wrap at all, so the wrapper is DETECTED rather than assumed — both
  // shapes have to arrive here as repo-relative paths or the layout rules see
  // two different repos.
  const root = "lloydtabb-malloyyo_examples-ddef919";
  const t = extractTarGz(
    tarball(
      entry(`${root}/`, "", { type: "5" }),
      entry(`${root}/malloy-config.json`, '{"connections":{}}'),
      entry(`${root}/datasets/babynames/index.malloy`, "source: x is duckdb.sql('select 1')"),
    ),
  );
  assert.deepEqual(
    [...t.files.keys()].sort(),
    ["datasets/babynames/index.malloy", "malloy-config.json"],
  );
  assert.equal(t.files.get("malloy-config.json"), '{"connections":{}}');
});

test("an archive with no wrapper is left alone", () => {
  const t = extractTarGz(tarball(entry("index.malloy", "a"), entry("malloy-config.json", "{}")));
  assert.deepEqual([...t.files.keys()].sort(), ["index.malloy", "malloy-config.json"]);
});

test("a single top-level directory that is REAL is not mistaken for a wrapper", () => {
  // Everything under `datasets/` and nothing else — stripping that would publish
  // the wrong repo entirely.
  const t = extractTarGz(
    tarball(
      entry("datasets/a/index.malloy", "a"),
      entry("datasets/b/index.malloy", "b"),
    ),
  );
  // These share `datasets` exactly the way a GitHub wrapper is shared, so
  // "everything under one directory" cannot be the rule — stripping here would
  // turn one multi-dataset repo into two nameless ones.
  assert.deepEqual(
    [...t.files.keys()].sort(),
    ["datasets/a/index.malloy", "datasets/b/index.malloy"],
  );
});

test("long paths: the ustar prefix field, GNU long names, and pax headers", () => {
  const deep = "datasets/a-very-long-dataset-directory-name-that-goes-on/dashboards";
  const t = extractTarGz(
    tarball(
      // ustar splits at the last slash that fits: prefix + name.
      entry("index.malloy", "prefixed", { prefix: "root-wrapper/datasets/one" }),
      // GNU: an 'L' entry whose DATA is the next entry's path.
      entry("././@LongLink", `root-wrapper/${deep}/a_long_dashboard_name.malloy\0`, { type: "L" }),
      entry("ignored-name", "gnu-long", {}),
      // pax: "<len> path=<value>\n" records.
      entry("PaxHeader", `${`${"path=root-wrapper/datasets/two/index.malloy"}`.length + 5} path=root-wrapper/datasets/two/index.malloy\n`, { type: "x" }),
      entry("also-ignored", "pax-long", {}),
    ),
  );
  const keys = [...t.files.keys()].sort();
  assert.ok(keys.includes("datasets/one/index.malloy"), `ustar prefix honoured: ${keys}`);
  assert.ok(
    keys.includes(`${deep}/a_long_dashboard_name.malloy`),
    `GNU long name honoured: ${keys}`,
  );
  assert.ok(keys.includes("datasets/two/index.malloy"), `pax path honoured: ${keys}`);
  assert.equal(t.files.get("datasets/two/index.malloy"), "pax-long");
});

test("directories and non-model files are skipped, and the skips are reported", () => {
  // A model repo may hold committed data and built docs. Decoding those to
  // strings would cost memory for bytes nothing ever reads — but a caller still
  // needs to be able to say WHY a file it expected is not there.
  const t = extractTarGz(
    tarball(
      entry("r/datasets/", "", { type: "5" }),
      entry("r/index.malloy", "kept"),
      entry("r/data/big.parquet", "\u0000binary"),
      entry("r/.gitignore", "node_modules"),
    ),
  );
  assert.deepEqual([...t.files.keys()], ["index.malloy"]);
  assert.deepEqual(t.skipped.sort(), [".gitignore", "data/big.parquet"]);
});

test("ArchiveURLReader records only what the compiler asked for", () => {
  // The archive is the whole repo; a dataset stores its own transitive closure.
  // `fetched` is what gets written, and the rest is never anybody's file.
  const files = new Map([
    ["index.malloy", "a"],
    ["gs.malloy", "b"],
    ["unused.malloy", "c"],
  ]);
  const reader = new ArchiveURLReader(files);
  return Promise.all([
    reader.readURL(new URL("file:///index.malloy")),
    reader.readURL(new URL("file:///gs.malloy")),
  ]).then(async ([a, b]) => {
    assert.equal(a, "a");
    assert.equal(b, "b");
    assert.deepEqual([...reader.fetched.keys()].sort(), ["gs.malloy", "index.malloy"]);
    await assert.rejects(() => reader.readURL(new URL("file:///nope.malloy")), /Not found: nope\.malloy/);
  });
});

test("archiveDir / archiveEntries list direct children only", () => {
  const files = new Map([
    ["index.malloy", ""],
    ["datasets/a/index.malloy", ""],
    ["datasets/a/dashboards/x.malloy", ""],
    ["datasets/b/index.malloy", ""],
  ]);
  // Directories are inferred: an archive has no entries for them of its own.
  assert.deepEqual(
    archiveEntries(files, "").map((e) => `${e.type}:${e.name}`),
    ["dir:datasets", "file:index.malloy"],
  );
  assert.deepEqual(
    archiveEntries(files, "datasets/a").map((e) => `${e.type}:${e.name}`),
    ["dir:dashboards", "file:index.malloy"],
  );
  // A prefix that only looks like a directory must not match.
  assert.deepEqual(archiveEntries(new Map([["datasets_old/x", ""]]), "datasets"), []);
});

test("a corrupt archive is an error, not a silently empty repo", () => {
  // "No files" and "could not read" must not look the same: one publishes
  // nothing, the other should refuse.
  assert.throws(() => extractTarGz(Buffer.from("not a gzip at all")), /not a gzipped archive/);
});

// ── Round trip ──────────────────────────────────────────────────────────────

test("what the CLI packs is what the server extracts", () => {
  // The equivalence the whole arrangement rests on. `malloyyo publish` builds an
  // archive and the server unpacks it; if these two ever drift, a repo publishes
  // differently depending on which way it arrived — which is precisely what
  // having one format is meant to prevent.
  const repo = new Map([
    ["malloy-config.json", '{"connections":{"duckdb":{"is":"duckdb"}}}'],
    ["datasets/babynames/index.malloy", "import { baby_names } from 'baby_names.malloy'"],
    ["datasets/babynames/baby_names.malloy", "source: baby_names is duckdb.table('x.parquet')"],
    ["datasets/babynames/dashboards/name_explorer.malloy", "run: baby_names -> { select: * }"],
    ["datasets/multi_tenant/index.malloy", "given:\n  MALLOYYO_EMAIL :: string is ''"],
  ]);
  const out = extractTarGz(buildTarGz(repo));
  assert.deepEqual([...out.files.keys()].sort(), [...repo.keys()].sort());
  for (const [path, content] of repo) {
    assert.equal(out.files.get(path), content, `${path} survived the round trip`);
  }
  assert.deepEqual(out.skipped, []);
});

test("round trip: a path too long for the 100-byte name field", () => {
  // ustar splits at a slash into name + prefix. A real dataset path —
  // datasets/<name>/dashboards/<name>.malloy — passes 100 bytes easily once the
  // names are words rather than letters.
  const long =
    "datasets/customer_reports_by_organization/dashboards/quarterly_revenue_by_segment_and_region_detail.malloy";
  assert.ok(long.length > 100, "the fixture is actually long enough to matter");
  const out = extractTarGz(buildTarGz(new Map([[long, "run: x -> { select: * }"], ["index.malloy", "a"]])));
  assert.equal(out.files.get(long), "run: x -> { select: * }");
});

test("an archive the CLI builds needs no wrapper directory, and the reader agrees", () => {
  // GitHub wraps; the CLI does not. Both have to arrive repo-relative.
  const out = extractTarGz(buildTarGz(new Map([["index.malloy", "a"], ["dashboards/x.malloy", "b"]])));
  assert.deepEqual([...out.files.keys()].sort(), ["dashboards/x.malloy", "index.malloy"]);
});

test("a path that cannot fit any tar header is refused, not truncated", () => {
  // Silently shortening a path would publish a file under the wrong name.
  const absurd = "datasets/" + "x".repeat(200) + "/" + "y".repeat(120) + ".malloy";
  assert.throws(() => buildTarGz(new Map([[absurd, "a"]])), /path too long for a tar header/);
});

// ── Hostile input ───────────────────────────────────────────────────────────
//
// The extractor reads bytes a caller supplies (POST /api/repos/push), so
// "parses a real GitHub tarball correctly" is not the property that matters.
// Each of these was demonstrated against the shipped code before being fixed.

test('a decompression bomb is refused, not materialised', () => {
  // gunzipSync with no maxOutputLength defaults to buffer.kMaxLength — none. A
  // 4MB upload of compressed NULs expanded past a gigabyte before any per-member
  // cap was consulted, because those are checked AFTER the archive is in memory.
  // Measured at 1029:1.
  const huge = Buffer.concat([
    entry('datasets/a/index.malloy', 'x'),
    Buffer.alloc(BLOCK * 2, 0),
  ]);
  const padded = Buffer.concat([huge, Buffer.alloc(200 * 1024 * 1024, 0)]);
  assert.throws(() => extractTarGz(gzipSync(padded)), /expands past|exceeds/);
});

test('a path that escapes the archive is dropped, and reported', () => {
  // Nothing writes these to disk today and `fileUrl` clamps `..` at the root —
  // but that containment lives in other code, and a parser reading attacker
  // bytes should not depend on it.
  const hostile = [
    'r/../../../../etc/passwd.malloy',
    'r/..\\..\\win.malloy',
    'r/ok.malloy',
  ];
  const t = extractTarGz(
    tarball(...hostile.map((n) => entry(n, 'x')), entry('r/index.malloy', 'root')),
  );
  assert.deepEqual([...t.files.keys()].sort(), ['index.malloy', 'ok.malloy']);
  assert.ok(
    t.skipped.some((p) => p.includes('etc/passwd')),
    `the escape is reported, not silently gone: ${JSON.stringify(t.skipped)}`,
  );
});

test('an absolute member name is dropped', () => {
  // It survived extraction before, and an absolute stored path collapses onto
  // the same file:// URL as its relative twin at serve time — two files that are
  // distinct at publish and identical when read back.
  const t = extractTarGz(tarball(entry('/etc/cron.d/evil.malloy', 'x'), entry('index.malloy', 'ok')));
  assert.deepEqual([...t.files.keys()], ['index.malloy']);
});

test('a truncated archive is an error, not a short one', () => {
  // Returning what was read publishes a repo missing files — and a missing
  // dashboard is non-fatal further up, so a half-downloaded tarball would
  // silently delete a dataset's dashboards rather than fail.
  const whole = tarball(
    entry('r/index.malloy', 'a'),
    entry('r/dashboards/one.malloy', 'b'),
    entry('r/dashboards/two.malloy', 'c'),
  );
  const cut = gzipSync(gunzipSync(whole).subarray(0, BLOCK * 4));
  assert.throws(() => extractTarGz(cut), /truncated/);
});

test('the ustar prefix is joined even when the name starts with it', () => {
  // The old `!name.startsWith(prefix)` guard dropped the prefix for a name that
  // legitimately began with that string, producing a wrong path.
  const t = extractTarGz(
    tarball(entry('datasets/x.malloy', 'v', { prefix: 'r/datasets' }), entry('r/index.malloy', 'i')),
  );
  assert.ok(
    [...t.files.keys()].includes('datasets/datasets/x.malloy'),
    `prefix joined unconditionally: ${[...t.files.keys()]}`,
  );
});
