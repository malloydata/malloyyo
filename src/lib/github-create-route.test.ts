// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Adding a GitHub repo is a WIRING surface: it must go through the one publish
// pipeline, not a loader of its own.
//
// The failure this guards against happened twice in different shapes. A second
// inline loader once fetched only index.malloy and its imports, so a new dataset
// was "ready" with no dashboards until somebody pressed refresh. Later, the
// create route kept its own per-dataset loop while refresh had moved on to
// compiling a whole repo at one commit — so the two ways a repo first arrives
// read it differently.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const route = readFileSync(join(ROOT, "src", "app", "api", "datasets", "route.ts"), "utf8");

test("adding a GitHub repo goes through the shared publish pipeline, once", () => {
  assert.match(route, /import \{ publishRevision \} from "@\/lib\/repo-publish"/);
  assert.equal(
    [...route.matchAll(/publishRevision\(/g)].length,
    1,
    "exactly one call — a second would be a second ingestion to keep in step",
  );
});

test("…and tells it the datasets do not exist yet, so the first model sets the scoping", () => {
  // Without `createDatasets`, nothing lands. And the pipeline treats a dataset
  // it is CREATING as taking its requirement from the model, because no admin
  // has had a chance to tick anything yet — a dataset made from a repo whose
  // model declares MALLOYYO_EMAIL must record that requirement, or `leaseScope`
  // finalizes nothing, core locks no name, and a caller who passes the given
  // themselves reads whichever tenant they name.
  assert.match(route, /createDatasets:\s*true/);
});

test("…and reads the repo ONCE, not once per dataset", () => {
  // `fetchRepo` returns the whole repo as one zip. Fetching per dataset would
  // download it per dataset, which is the cost reading an archive exists to
  // remove — and a four-dataset repo is exactly where it hurt.
  assert.equal([...route.matchAll(/fetchRepo\(/g)].length, 1);
});

test("the create route has no loader, no compile and no file-row writes of its own", () => {
  for (const forbidden of [
    "GitHubURLReader",
    "introspectModelWithReader",
    "malloyModelFiles",
    "discoverRepoLayout",
    "layoutFromListing",
  ]) {
    assert.ok(!route.includes(forbidden), `the create route must not reach ${forbidden}`);
  }
});

test("the only row it writes before the pipeline is the repo, and it is harmless", () => {
  // A repo row with no active revision serves nothing and holds no name anyone
  // can reach — unlike the `ready` DATASET rows the previous version wrote and
  // then deleted, which held their names under a unique index and could not be
  // released if the process died. So this insert needs no compensating action,
  // and the delete below is a courtesy (this route's contract is "a repo with
  // datasets, or an error"), not a correctness requirement.
  assert.doesNotMatch(
    route,
    /\binsert\(datasets\)/,
    "dataset rows are the activation transaction's business",
  );
  assert.match(route, /\.insert\(repos\)/);
});
