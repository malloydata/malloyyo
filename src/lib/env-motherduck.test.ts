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
