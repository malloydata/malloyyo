// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// DuckDB's MotherDuck extension reads `motherduck_token` from the process
// environment by itself, so the server's token must not be left there: a
// model's md: connection with no token of its own would sign in as the server.

import { test } from "node:test";
import assert from "node:assert/strict";

test("the server's MotherDuck token leaves the process environment and stays reachable through env", async () => {
  process.env.MOTHERDUCK_TOKEN = "server-token";
  process.env.motherduck_token = "server-token";
  const { env } = await import("./env");
  assert.equal(process.env.MOTHERDUCK_TOKEN, undefined);
  assert.equal(process.env.motherduck_token, undefined);
  assert.equal(env.MOTHERDUCK_TOKEN, "server-token");
});

test('a config that names it — {"env": "MOTHERDUCK_TOKEN"} — gets the server\'s token', async () => {
  // env.ts captured "server-token" and cleared the variable in the test above
  // (one module instance per process); the overlay must answer from the
  // capture, with nothing left in the environment to read.
  const { env } = await import("./env");
  assert.equal(env.MOTHERDUCK_TOKEN, "server-token");
  const { configEnvOverlay } = await import("./config-env");
  const refused: string[] = [];
  const read = configEnvOverlay(process.env, (n) => refused.push(n));
  assert.equal(read(["MOTHERDUCK_TOKEN"]), "server-token");
  assert.deepEqual(refused, []);
  // Still not through the environment itself, and still not under a server name.
  assert.equal(process.env.MOTHERDUCK_TOKEN, undefined);
  assert.equal(read(["DATABASE_URL"]), undefined);
  assert.deepEqual(refused, ["DATABASE_URL"]);
});
