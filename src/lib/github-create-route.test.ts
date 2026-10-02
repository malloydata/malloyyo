// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Initial GitHub dataset creation is a wiring surface: it must use the same importer as
// manual refresh and webhooks. That importer owns dashboard discovery, model-file storage,
// and artifact storage. A second inline loader once fetched only index.malloy and its
// imports, so a new dataset was "ready" with no dashboards until somebody refreshed it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const CREATE_ROUTE = join(ROOT, "src", "app", "api", "datasets", "route.ts");
const route = readFileSync(CREATE_ROUTE, "utf8");

test("initial GitHub dataset creation uses the dashboard-aware refresh importer", () => {
  assert.match(route, /import \{[^}]*refreshGitHubModel[^}]*\} from "@\/lib\/github-refresh"/);
  assert.equal(
    [...route.matchAll(/refreshGitHubModel\(id\b/g)].length,
    1,
    "the create route must call the shared importer exactly once",
  );
});

test("…and tells it this is a CREATE, so the first model sets the scoping", () => {
  // Without `creating`, a dataset made from a repo whose model declares
  // MALLOYYO_EMAIL records no requirement. `leaseScope` then finalizes nothing,
  // so core locks no name and the usage gate is off — the dataset looks scoped
  // (the declaration default '' matches no rows) while a caller who passes the
  // given themselves reads whichever tenant they name. The CLI push path has
  // always done this; only the UI path was missing it.
  assert.match(route, /refreshGitHubModel\(id,\s*\{[^}]*creating:\s*true/);
});

test("…and reads the repo ONCE, not once per dataset", () => {
  // The context holds the repo archive. Building it per dataset would download
  // the whole repo per dataset, which is the cost reading an archive exists to
  // remove — and a four-dataset repo is exactly where it would hurt.
  assert.match(route, /repoContext\(/, "the route builds the context itself");
  assert.match(route, /refreshGitHubModel\(id,\s*\{[^}]*ctx\b/, "and hands it to every dataset");
});

test("initial GitHub dataset creation has no second root-model-only loader", () => {
  assert.doesNotMatch(route, /GitHubURLReader/);
  assert.doesNotMatch(route, /introspectModelWithReader/);
  assert.doesNotMatch(route, /malloyModelFiles/);
});
