// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// A repo's config names env vars; the server's environment holds its own
// secrets. These pin the line: the server's never resolve, and an operator's
// MALLOY_CONFIG_ENV narrows the rest.

import { test } from "node:test";
import assert from "node:assert/strict";
import { configEnvOverlay, configMayRead, isServerSecret } from "./config-env";

test("the server's own secrets never resolve", () => {
  for (const name of [
    "DATABASE_URL",
    "DATABASE_URL_UNPOOLED",
    "POSTGRES_PASSWORD",
    "PGPASSWORD",
    "PGHOST",
    "AUTH_SECRET",
    "AUTH_GOOGLE_SECRET",
    "NEXTAUTH_SECRET",
    "OAUTH_SIGNING_SECRET",
    "DASHBOARD_TOKEN_SECRET",
    "GITHUB_TOKEN",
    "GITHUB_WEBHOOK_SECRET",
    "ANTHROPIC_API_KEY",
    "VERCEL_OIDC_TOKEN",
    "MOTHERDUCK_TOKEN",
    "SOME_NEW_PROVIDER_SECRET",
    "database_url",
  ]) {
    assert.ok(isServerSecret(name), name);
    // ...even when the operator lists them.
    assert.equal(configMayRead(name, `${name},*`), false, name);
  }
});

test("warehouse credentials under their own names resolve by default", () => {
  for (const name of ["MALLOYYO_TOKEN", "WAREHOUSE_PG_PASSWORD", "BQ_SERVICE_ACCOUNT_JSON", "SNOWFLAKE_PASSWORD"]) {
    assert.equal(configMayRead(name, undefined), true, name);
  }
});

test("MALLOY_CONFIG_ENV narrows to listed names and PREFIX_* patterns", () => {
  const allow = " MALLOYYO_TOKEN , WAREHOUSE_* ";
  assert.equal(configMayRead("MALLOYYO_TOKEN", allow), true);
  assert.equal(configMayRead("WAREHOUSE_PG_PASSWORD", allow), true);
  assert.equal(configMayRead("SNOWFLAKE_PASSWORD", allow), false);
  assert.equal(configMayRead("MALLOYYO_TOKEN_2", allow), false);
});

test("the overlay resolves allowed names, drops the rest, and reports refusals", () => {
  const env = {
    DATABASE_URL: "postgres://meta",
    WAREHOUSE_PG_PASSWORD: "w",
    OTHER: "o",
    MALLOY_CONFIG_ENV: "WAREHOUSE_*",
  };
  const refused: string[] = [];
  const overlay = configEnvOverlay(env, (n) => refused.push(n));
  assert.equal(overlay(["WAREHOUSE_PG_PASSWORD"]), "w");
  assert.equal(overlay(["DATABASE_URL"]), undefined);
  assert.equal(overlay(["OTHER"]), undefined);
  assert.equal(overlay([]), undefined);
  assert.deepEqual(refused, ["DATABASE_URL", "OTHER"]);
});

test("the overlays the server hands Malloy refuse its own secrets", async () => {
  const { serverConfigOverlays } = await import("./malloy");
  const prev = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://metadata-db";
  try {
    const env = serverConfigOverlays().env as (path: string[]) => unknown;
    assert.equal(await env(["DATABASE_URL"]), undefined);
  } finally {
    if (prev === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prev;
  }
});
