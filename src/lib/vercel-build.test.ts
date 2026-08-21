// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import { runVercelBuild, vercelBuildMigrationsEnabled } from "./vercel-build.js";

test("a Production Vercel build compiles before it migrates", async () => {
  const calls: string[] = [];

  await runVercelBuild({
    environment: { VERCEL_ENV: "production" },
    build: async () => void calls.push("build"),
    migrate: async () => void calls.push("migrate"),
  });

  assert.deepEqual(calls, ["build", "migrate"]);
});

test("a failed application build never reaches the database", async () => {
  let migrated = false;

  await assert.rejects(
    runVercelBuild({
      environment: { VERCEL_ENV: "production" },
      build: async () => {
        throw new Error("compile failed");
      },
      migrate: async () => {
        migrated = true;
      },
    }),
    /compile failed/,
  );

  assert.equal(migrated, false);
});

test("Preview builds cannot migrate a possibly shared database without an opt-in", async () => {
  const calls: string[] = [];

  await runVercelBuild({
    environment: { VERCEL_ENV: "preview" },
    build: async () => void calls.push("build"),
    migrate: async () => void calls.push("migrate"),
  });

  assert.deepEqual(calls, ["build"]);
  assert.equal(
    vercelBuildMigrationsEnabled({
      VERCEL_ENV: "preview",
      RUN_MIGRATIONS_ON_BUILD: "1",
    }),
    true,
  );
});

test("an operator can disable Production build migrations for an out-of-band schema", () => {
  assert.equal(
    vercelBuildMigrationsEnabled({
      VERCEL_ENV: "production",
      RUN_MIGRATIONS_ON_BUILD: "false",
    }),
    false,
  );
});

test("an invalid migration switch fails closed", () => {
  assert.throws(
    () => vercelBuildMigrationsEnabled({ RUN_MIGRATIONS_ON_BUILD: "sometimes" }),
    /must be 1, true, 0, or false/,
  );
});
