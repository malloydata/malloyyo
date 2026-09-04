// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createDeepHealthHandler } from "./deep-health.js";
import { VERSION } from "./version.js";

const savedBootMigrations = process.env.RUN_MIGRATIONS_ON_BOOT;

afterEach(() => {
  if (savedBootMigrations === undefined) delete process.env.RUN_MIGRATIONS_ON_BOOT;
  else process.env.RUN_MIGRATIONS_ON_BOOT = savedBootMigrations;
  delete globalThis.__malloyyoMigrationOutcome__;
});

test("deep health identifies the exact Fly Machine that answered", async () => {
  process.env.RUN_MIGRATIONS_ON_BOOT = "0";
  const get = createDeepHealthHandler(async () => undefined, {
    FLY_MACHINE_ID: "d891deed002e38",
  });

  const response = await get();

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    postgres: "ok",
    version: VERSION,
    runtime: { flyMachineId: "d891deed002e38" },
  });
});

test("deep health keeps its existing response shape outside Fly", async () => {
  process.env.RUN_MIGRATIONS_ON_BOOT = "0";
  const get = createDeepHealthHandler(async () => undefined, {});

  assert.deepEqual(await (await get()).json(), {
    status: "ok",
    postgres: "ok",
    version: VERSION,
  });
});

test("deep health still identifies a Fly Machine when its database check fails", async () => {
  process.env.RUN_MIGRATIONS_ON_BOOT = "0";
  const get = createDeepHealthHandler(
    async () => {
      throw new Error("database unavailable");
    },
    { FLY_MACHINE_ID: "d891deed002e38" },
  );

  const response = await get();
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 503);
  assert.deepEqual(body.runtime, { flyMachineId: "d891deed002e38" });
});
