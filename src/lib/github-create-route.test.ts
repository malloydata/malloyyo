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
  assert.match(route, /import \{ refreshGitHubModel \} from "@\/lib\/github-refresh"/);
  assert.equal(
    [...route.matchAll(/refreshGitHubModel\(id\)/g)].length,
    1,
    "the create route must call the shared importer exactly once",
  );
});

test("initial GitHub dataset creation has no second root-model-only loader", () => {
  assert.doesNotMatch(route, /GitHubURLReader/);
  assert.doesNotMatch(route, /introspectModelWithReader/);
  assert.doesNotMatch(route, /malloyModelFiles/);
});
