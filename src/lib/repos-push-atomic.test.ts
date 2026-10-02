// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// `POST /api/repos/push` creates datasets, and creating them is the step that
// has to be atomic with the compile.
//
// The shape that shipped first was insert-then-compile-then-delete-on-failure.
// It passes every test you can write against a process that stays alive, and it
// is wrong for the one that does not: the delete is a compensating action, so a
// timeout or a redeploy during the compile — network I/O plus schema resolution
// that runs SQL, i.e. the slow part — left `ready` dataset rows with no model
// behind them. Those rows hold their names under `datasets_name_ready_unique`,
// so the rightful publish afterwards got a 409 and nothing on the instance could
// release it. The window is not reachable from a test, so what is pinned here is
// the mechanism that closes it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const route = readFileSync(join(ROOT, "src", "app", "api", "repos", "push", "route.ts"), "utf8");
const refresh = readFileSync(join(ROOT, "src", "lib", "github-refresh.ts"), "utf8");

test("the route never writes a dataset row itself", () => {
  // Every insert this request makes belongs to compileAndWrite's transaction.
  assert.doesNotMatch(
    route,
    /db\s*\.?\s*insert\s*\(\s*datasets\s*\)/,
    "the rows are built and handed over, not written here",
  );
});

test("…and never deletes one either, because there is nothing to undo", () => {
  // A delete here would mean something had been committed early again.
  assert.doesNotMatch(route, /delete\s*\(\s*datasets\s*\)/);
});

test("the rows it builds are passed to compileAndWrite as the third argument", () => {
  assert.match(route, /compileAndWrite\(/);
  assert.match(route, /newRows,\s*\n\s*\)/, "handed over to be inserted in the transaction");
});

test("compileAndWrite inserts those rows INSIDE its transaction, before the versions", () => {
  // Order matters as much as placement: malloyModels.datasetId is a foreign key,
  // so the row has to exist in the transaction before the version referencing it.
  const tx = /db\.transaction\(async \(tx\) => \{([\s\S]*?)\n  \}\);/.exec(refresh)?.[1];
  assert.ok(tx, "compileAndWrite still writes in one transaction");
  const insertAt = tx.indexOf("tx.insert(datasets)");
  const writeAt = tx.indexOf("writeCompiled(");
  assert.ok(insertAt >= 0, "the creates happen inside the transaction");
  assert.ok(writeAt >= 0, "so do the model versions");
  assert.ok(insertAt < writeAt, "creates first — the versions reference them");
});

test("a failed compile returns before the transaction opens", () => {
  // Not merely "writes nothing": nothing is created either, which is only true
  // while the inserts live inside that transaction.
  const from = refresh.indexOf("export async function compileAndWrite(");
  const to = refresh.indexOf("export async function refreshRepo(");
  assert.ok(from >= 0 && to > from, "both functions are still here, in this order");
  const body = refresh.slice(from, to);
  const bail = body.indexOf("if (failed.length > 0) return");
  const txAt = body.indexOf("db.transaction(");
  assert.ok(bail >= 0 && txAt >= 0);
  assert.ok(bail < txAt, "the all-or-nothing check precedes any write");
});
