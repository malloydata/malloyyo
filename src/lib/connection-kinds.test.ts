// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The config guided setup writes: secrets only ever as {"env": NAME}, NAME
// derived from the connection, and literal values only when a caller passes
// them explicitly (the pre-save test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { configJsonFor, connectionEntry, envNamesFor, validateConnection } from "./connection-kinds";

test("secrets become env references named for the connection", () => {
  assert.deepEqual(envNamesFor("postgres", "warehouse"), ["WAREHOUSE_PASSWORD"]);
  assert.deepEqual(envNamesFor("bigquery", "bq"), ["BQ_SERVICE_ACCOUNT_KEY"]);
  assert.deepEqual(envNamesFor("motherduck", "md"), ["MD_TOKEN"]);
  const pg = connectionEntry("postgres", "warehouse", { host: "h", databaseName: "d", username: "u" });
  assert.deepEqual(pg.password, { env: "WAREHOUSE_PASSWORD" });
  assert.equal(pg.port, 5432);
  assert.equal(pg.ssl, true);
  assert.ok(!configJsonFor("warehouse", pg).includes("hunter2"));
});

test("literal secrets appear only when passed, for the pre-save test", () => {
  const e = connectionEntry("postgres", "w", { host: "h", databaseName: "d", username: "u" }, { password: "hunter2" });
  assert.equal(e.password, "hunter2");
});

test("per-kind config shapes", () => {
  assert.deepEqual(connectionEntry("motherduck", "md", { database: "sales" }), {
    is: "duckdb",
    databasePath: "md:sales",
    motherDuckToken: { env: "MD_TOKEN" },
  });
  assert.equal(connectionEntry("motherduck", "md", {}).databasePath, "md:");
  assert.deepEqual(connectionEntry("bigquery", "bq", { projectId: "p" }), {
    is: "bigquery",
    projectId: "p",
    serviceAccountKeyJson: { env: "BQ_SERVICE_ACCOUNT_KEY" },
  });
  assert.equal(connectionEntry("postgres", "w", { host: "h", databaseName: "d", username: "u", ssl: "false" }).ssl, undefined);
});

test("validation: names, required fields, numbers; secrets are never taken from settings", () => {
  assert.equal(validateConnection("oracle", "x").ok, false);
  assert.equal(validateConnection("postgres", "Warehouse", {}).ok, false);
  assert.equal(validateConnection("postgres", "w", { host: "h" }).ok, false);
  assert.equal(validateConnection("postgres", "w", { host: "h", databaseName: "d", username: "u", port: "x" }).ok, false);
  const v = validateConnection("postgres", "w", { host: "h", databaseName: "d", username: "u", password: "leak" });
  assert.ok(v.ok && !("password" in v.settings));
});
