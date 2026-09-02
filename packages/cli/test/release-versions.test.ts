// The release writes one version into four places: the CLI manifest, the
// server's manifest, and two fields in the lock. Every deployment's answer to
// "what code am I?" comes from the server one, so a release that moved some but
// not all of them would ship a server lying about its own version — silently,
// with a green build.
//
// The git and npm halves of release.ts stay untested (a test cannot safely
// publish); these are the pure file rewrites, which is where a partial bump
// would come from.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncLockVersion, syncRootVersion } from "../scripts/release.js";

/** A lock shaped like npm's: the root recorded twice, plus each workspace. */
function writeLock(dir: string, version: string): string {
  const file = path.join(dir, "package-lock.json");
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        name: "@malloyyo/server",
        version,
        lockfileVersion: 3,
        packages: {
          "": { name: "@malloyyo/server", version },
          "packages/cli": { name: "@malloydata/malloyyo", version: "0.0.1" },
          "packages/mcp-engine": { version: "0.0.1" },
        },
      },
      null,
      2,
    ) + "\n",
  );
  return file;
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "release-versions-"));
}

test("one version reaches every field the lock records", () => {
  const dir = tmpdir();
  const lock = writeLock(dir, "0.2.31");

  assert.equal(syncLockVersion("9.9.9", lock), true);

  const after = JSON.parse(fs.readFileSync(lock, "utf8"));
  assert.equal(after.version, "9.9.9", "top-level version");
  assert.equal(after.packages[""].version, "9.9.9", 'packages[""] — the server');
  assert.equal(after.packages["packages/cli"].version, "9.9.9", "the CLI workspace");
  // Not everything: the engine is unpublished and pinned.
  assert.equal(after.packages["packages/mcp-engine"].version, "0.0.1");
});

test("the server's manifest moves with it", () => {
  const dir = tmpdir();
  const file = path.join(dir, "package.json");
  fs.writeFileSync(file, JSON.stringify({ name: "@malloyyo/server", version: "0.2.31" }, null, 2) + "\n");

  assert.equal(syncRootVersion("9.9.9", file), true);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).version, "9.9.9");
});

test("a lock missing a version field aborts the release", () => {
  const dir = tmpdir();
  const file = path.join(dir, "package-lock.json");
  // packages[""] gone — the shape npm would produce if the root stopped being a
  // workspace root. Throwing is the point: the alternative is a release that
  // publishes a server whose version silently did not move.
  fs.writeFileSync(
    file,
    JSON.stringify({ version: "0.2.31", packages: { "packages/cli": { version: "0.2.31" } } }, null, 2) + "\n",
  );

  assert.throws(() => syncLockVersion("9.9.9", file), /packages\[""\]/);
});

test("a manifest missing a version field aborts the release", () => {
  const dir = tmpdir();
  const file = path.join(dir, "package.json");
  fs.writeFileSync(file, JSON.stringify({ name: "@malloyyo/server" }, null, 2) + "\n");

  assert.throws(() => syncRootVersion("9.9.9", file), /no version field/);
});

test("an already-current file is left byte-identical", () => {
  // The return value drives whether the release commits at all, so "no change"
  // has to be reported as false rather than as a rewrite that happens to match.
  const dir = tmpdir();
  const lock = writeLock(dir, "0.2.31");
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "@malloyyo/server", version: "0.2.31" }, null, 2) + "\n",
  );
  // Bring the CLI entry up first, so the second call has genuinely nothing to do.
  syncLockVersion("0.2.31", lock);
  const before = fs.readFileSync(lock, "utf8");

  assert.equal(syncLockVersion("0.2.31", lock), false);
  assert.equal(fs.readFileSync(lock, "utf8"), before);
  assert.equal(syncRootVersion("0.2.31", path.join(dir, "package.json")), false);
});

test("npm's formatting survives the round trip", () => {
  // The edit is surgical so the release diff stays on the version line. npm
  // writes these files as JSON.stringify(…, null, 2) with a trailing newline;
  // if that ever stopped matching, every release would carry a whole-file diff.
  const dir = tmpdir();
  const lock = writeLock(dir, "0.2.31");
  syncLockVersion("9.9.9", lock);
  const text = fs.readFileSync(lock, "utf8");

  assert.ok(text.endsWith("}\n"), "trailing newline");
  assert.match(text, /\n {2}"version": "9\.9\.9",/, "two-space indent");
});
