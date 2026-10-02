// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// NO COMPENSATING ACTIONS, pinned at the mechanism.
//
// The shape that shipped first was insert-then-compile-then-delete-on-failure.
// It passes every test you can write against a process that STAYS ALIVE, and it
// is wrong for the one that does not: the delete is a compensating action, so a
// timeout or a redeploy during the compile — network I/O plus schema resolution
// that runs SQL, i.e. the slow part — left `ready` dataset rows with no model
// behind them, holding their names under a unique index, and the rightful
// publish afterwards got a permanent 409.
//
// This file is the carried-forward version of that pin, rewritten for the shape
// that replaced it. THE WINDOW IS NOT REACHABLE FROM A TEST — it needs a dying
// process — so what is asserted here is the mechanism that closes it, and that
// is said plainly rather than dressed up as a behavioural test:
//
//   * the revision commits first and is INERT (`active` false), so there is
//     nothing to undo if the process dies next;
//   * the activation transaction contains no compile, no network and no
//     archive — only database writes, all of which are in it;
//   * dataset rows are created INSIDE that transaction, before the model
//     versions that reference them.
//
// The behavioural half — a failed verification leaves the previous revision
// serving, and the failed revision behind as a record — is in
// test/repo-publish.test.ts against a real Postgres and a real compile.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const route = readFileSync(join(ROOT, "src", "app", "api", "repos", "push", "route.ts"), "utf8");
const pipeline = readFileSync(join(ROOT, "src", "lib", "repo-publish.ts"), "utf8");

test("the route never writes or deletes a dataset row itself", () => {
  // Every dataset insert this request makes belongs to the activation
  // transaction. A delete here would mean something had been committed early
  // again — which is the whole bug.
  assert.doesNotMatch(
    route,
    /db\s*\.?\s*insert\s*\(\s*datasets\s*\)/,
    "dataset rows are created by the activation, not by the route",
  );
  assert.doesNotMatch(route, /delete\s*\(\s*datasets\s*\)/, "nothing to undo, so nothing undoes it");
});

test("a stored revision is inert: nothing in storeRevision activates it", () => {
  const from = pipeline.indexOf("async function storeRevision(");
  const to = pipeline.indexOf("async function recordFailure(");
  assert.ok(from >= 0 && to > from, "storeRevision is still here, before recordFailure");
  const body = pipeline.slice(from, to);
  assert.doesNotMatch(body, /active:\s*true/, "the store must not activate — that is the point");
  assert.doesNotMatch(body, /verifiedAt/, "and must not claim the revision verified");
});

test("the activation transaction does no I/O — it only writes the database", () => {
  // If anything slow or fallible were in here, the transaction would be held
  // open across it and "the repo's datasets move together" would cost
  // availability. Everything slow already happened; its result is in memory.
  const from = pipeline.indexOf("async function activate(");
  assert.ok(from >= 0, "activate() is still the one mutation that makes a publish visible");
  const body = pipeline.slice(from);
  for (const forbidden of [
    "materializeArchive",
    "normalizeArchive",
    "introspectModelWithReader",
    "withReaderRuntime",
    "compileDir",
    "fetch(",
    "readFileSync",
  ]) {
    assert.ok(!body.includes(forbidden), `activate() must not reach ${forbidden}`);
  }
});

test("dataset rows are created inside the activation, before the versions that reference them", () => {
  // Order matters as much as placement: malloy_models.dataset_id is a foreign
  // key, so the row has to exist in the transaction before the version.
  const from = pipeline.indexOf("async function activate(");
  const body = pipeline.slice(from);
  const txAt = body.indexOf("db.transaction(");
  const insertDs = body.indexOf("tx\n            .insert(datasets)");
  const insertModel = body.indexOf(".insert(malloyModels)");
  assert.ok(txAt >= 0, "the activation is one transaction");
  assert.ok(insertDs > txAt, "dataset creates happen inside it");
  assert.ok(insertModel > insertDs, "and before the model versions that reference them");
});

test("verification failure records, and returns, without activating", () => {
  // `recordFailure` writes `verify_error` and nothing else. A revision that
  // failed stays stored: it is the record of the attempt, and it is inert.
  const from = pipeline.indexOf("async function recordFailure(");
  const to = pipeline.indexOf("async function compileDir(");
  assert.ok(from >= 0 && to > from);
  const body = pipeline.slice(from, to);
  assert.match(body, /set\(\{\s*verifyError: error\s*\}\)/, "it records the reason");
  assert.doesNotMatch(body, /delete\(/, "and removes nothing");
});

test("activation never moves a repo backwards, and takes the repo's row lock to decide", () => {
  // Two publishes verify independently and both may succeed, so the slower,
  // older one can reach activation last. Without the comparison it would
  // quietly replace the newer revision.
  //
  // PINNED HERE because the race is not reachable from a test: the guard fires
  // only when the higher-numbered revision activates FIRST, and nothing can
  // force that interleaving. test/repo-publish.test.ts runs two publishes
  // concurrently and checks the INVARIANT (exactly one live revision, and it is
  // the highest that verified), which holds under either order — so it would
  // pass with the guard removed. This is the half that would not.
  const from = pipeline.indexOf("async function activate(");
  const body = pipeline.slice(from);
  assert.match(
    body,
    /select 1 from repos where id = \$\{input\.repo\.id\} for update/,
    "the repo row is locked, so the comparison cannot be read stale",
  );
  const lockAt = body.indexOf("for update");
  const compareAt = body.indexOf("live.revision > revision.revision");
  assert.ok(compareAt > lockAt, "and the comparison happens under that lock");
  assert.match(body, /return \{ stale: live\.revision as number \}/, "an older revision steps aside");
});
