// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// /api/healthz is the signal routine machinery polls: the service check hits it
// every 15 seconds on every hosted instance. Three properties make that safe,
// and each is pinned here:
//
//   1. it performs no I/O — a check that touched Postgres would hold every
//      hosted instance's scale-to-zero database awake permanently, which is the
//      whole reason this route exists separately from /api/health;
//   2. it fails readiness when startup failed, so a bad release is removed from
//      routing instead of accepting connections it cannot serve;
//   3. it answers status and version only — no driver message reaches a route
//      the public internet can poll.
//
// Oracle: the hosted health contract, which is what the service check and the
// hosted health reconciler are built against.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { recordMigrationOutcome } from "./migration-state.js";
import { VERSION } from "./version.js";
import { GET } from "../app/api/healthz/route.js";

const SAVED = process.env.RUN_MIGRATIONS_ON_BOOT;
afterEach(() => {
  if (SAVED === undefined) delete process.env.RUN_MIGRATIONS_ON_BOOT;
  else process.env.RUN_MIGRATIONS_ON_BOOT = SAVED;
  delete globalThis.__malloyyoMigrationOutcome__;
});

test("answers 200 with the version once startup succeeded", async () => {
  process.env.RUN_MIGRATIONS_ON_BOOT = "1";
  recordMigrationOutcome({ ok: true });

  const response = GET();

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", version: VERSION });
});

test("answers 503 when startup failed", async () => {
  // The point of the whole split: a release whose boot migrations fail now fails
  // its check and leaves routing, rather than accepting connections it cannot
  // serve.
  process.env.RUN_MIGRATIONS_ON_BOOT = "1";
  recordMigrationOutcome({ ok: false, error: 'relation "users" does not exist' });

  const response = GET();

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: "failed_startup", version: VERSION });
});

test("answers 503 for the whole boot window, before migrations have run", () => {
  // Readiness is false until boot migrations finish. The Fly check's grace
  // period is sized for exactly this.
  process.env.RUN_MIGRATIONS_ON_BOOT = "1";

  assert.equal(GET().status, 503);
});

test("never echoes the failure reason to a route the internet can poll", async () => {
  process.env.RUN_MIGRATIONS_ON_BOOT = "1";
  recordMigrationOutcome({
    ok: false,
    error: "connect ECONNREFUSED postgres://app:hunter2@db.internal:5432/malloyyo",
  });

  const body = JSON.stringify(await GET().json());

  assert.equal(body.includes("hunter2"), false);
  assert.equal(body.includes("db.internal"), false);
});

test("a self-hosted instance that runs no boot migrations is ready", () => {
  // Readiness only means anything for instances that migrate at boot. Everyone
  // else is ready as soon as the process is serving.
  process.env.RUN_MIGRATIONS_ON_BOOT = "0";

  assert.equal(GET().status, 200);
});

test("the handler is synchronous, so it cannot be awaiting I/O", () => {
  // The structural half of "no I/O": a handler that queried anything would have
  // to be async and return a promise. This is what would break the moment
  // someone added `await db.execute(...)` to it.
  process.env.RUN_MIGRATIONS_ON_BOOT = "0";

  assert.equal(GET() instanceof Promise, false);
});

test("imports nothing that can reach the database or the network", () => {
  // The other half, because a synchronous handler could still fire off an
  // un-awaited call. The import list is short by design: the readiness gate, the
  // version, and Next's response helper.
  const source = readFileSync(
    fileURLToPath(new URL("../app/api/healthz/route.ts", import.meta.url)),
    "utf8"
  );
  const imported = [...source.matchAll(/^import .*? from "([^"]+)";$/gm)].map((m) => m[1]);

  assert.deepEqual(imported.sort(), ["@/lib/migration-state", "@/lib/version", "next/server"]);
});
