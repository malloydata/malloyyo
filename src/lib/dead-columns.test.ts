// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// THE COLUMNS THAT MADE A REPO A QUERY PREDICATE, kept and unread.
//
// `datasets.github_repo`, `.github_branch` and `.github_use_token` are dead:
// every fact they held is on `repos` now, once. They are still in the schema
// because a Vercel build applies the journal BEFORE promoting the new code, so
// an entry that drops a column the currently live version still selects takes
// that version down for the length of the deploy — and the live version selects
// whole `datasets` rows in half a dozen places. The drop is one command in the
// release after this one.
//
// A comment saying "don't read these" would be exactly the kind of unenforced
// invariant that got the previous implementation into trouble (gotcha #7). This
// is the enforcement: a grep over the source, so re-wiring one of them is a red
// test rather than a silent return to per-dataset repo config.
//
// It also guards the thing those columns cost, which was never really about the
// columns: one repo in the production fork had three dataset rows carrying two
// different answers about its credential, and the refresh picked a winner with
// `rows[0]` on a query with no ORDER BY.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const SCHEMA = join("src", "db", "schema.ts");

/** The drizzle accessors. Matching these and not the SQL names keeps the test
    from firing on prose, on the migration, or on `repos.githubRepo`. */
const DEAD = [/\bdatasets\.githubRepo\b/, /\bdatasets\.githubBranch\b/, /\bdatasets\.githubUseToken\b/];

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(join(ROOT, dir))) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const rel = join(dir, entry);
    if (statSync(join(ROOT, rel)).isDirectory()) {
      yield* sources(rel);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      yield rel;
    }
  }
}

test("nothing reads the dead per-dataset GitHub columns", () => {
  const offenders: string[] = [];
  for (const rel of [...sources("src"), ...sources("test")]) {
    // schema.ts DECLARES them, which is the whole point.
    if (rel === SCHEMA) continue;
    // …and this file names them in order to forbid them.
    if (rel.endsWith("dead-columns.test.ts")) continue;
    const text = readFileSync(join(ROOT, rel), "utf8");
    for (const pattern of DEAD) {
      if (pattern.test(text)) offenders.push(`${rel}: ${pattern.source}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "these columns are dead — the repo carries the GitHub attachment now:\n" + offenders.join("\n"),
  );
});

test("…and the repo is where those three facts live", () => {
  const schema = readFileSync(join(ROOT, SCHEMA), "utf8");
  const repos = schema.slice(schema.indexOf('export const repos = pgTable('), schema.indexOf("export const repoRevisions"));
  for (const column of ["github_repo", "github_branch", "github_use_token"]) {
    assert.match(repos, new RegExp(`"${column}"`), `repos carries ${column}`);
  }
});

test("the drop is NOT in this release's journal", () => {
  // Said here as well as in the migration test, because this is the file
  // someone reads when they wonder why the dead columns are still declared.
  const journal = JSON.parse(
    readFileSync(join(ROOT, "drizzle", "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string }> };
  assert.ok(
    !journal.entries.some((e) => /drop_dataset_github/.test(e.tag)),
    "a drop entry here would be applied before the new code is promoted",
  );
});
