// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The parts of the API-token contract that don't need a database: the wire
// format (which the CLI and any secret scanner also depend on), what the
// create form is allowed to send, and how an expiry choice becomes a date.
//
// Run: npm test

import { before, test } from "node:test";
import assert from "node:assert/strict";

// Importing the module builds the (lazy) postgres client, which reads this.
// Nothing here connects. Deferred import so these land first.
process.env.DATABASE_URL ??= "postgres://api-tokens-test.invalid/malloyyo";
process.env.INSTANCE_CODE ??= "stg";

let lib: typeof import("./api-tokens");

before(async () => {
  lib = await import("./api-tokens.js");
});

test("a minted token is marker + instance code + secret, and hashes to its row key", () => {
  const minted = lib.mintTokenValue();
  assert.match(minted.raw, /^myo_stg_[A-Za-z0-9_-]{43}$/);
  assert.equal(minted.hash, lib.hashApiToken(minted.raw));
  // The stored hash must not be derivable back into the value.
  assert.ok(!minted.hash.includes(minted.raw.slice(8)));
  assert.equal(minted.prefix, `myo_stg_${minted.raw.slice(8, 16)}`);
  assert.ok(minted.prefix.length < minted.raw.length);
});

test("two mints never collide", () => {
  const seen = new Set(Array.from({ length: 50 }, () => lib.mintTokenValue().raw));
  assert.equal(seen.size, 50);
});

test("parsing survives a secret that contains base64url underscores", () => {
  // The reason parseApiToken doesn't split("_"): roughly a third of real
  // secrets carry one, and rejecting those would fail one token in three.
  const parsed = lib.parseApiToken("myo_stg_aa_bb-ccddeeffgghhiijjkkll");
  assert.ok(parsed);
  assert.equal(parsed.code, "stg");
  assert.equal(parsed.secret, "aa_bb-ccddeeffgghhiijjkkll");
  assert.equal(parsed.matchesInstance, true);
});

test("a token from another instance parses, and says it is from elsewhere", () => {
  const parsed = lib.parseApiToken(`myo_main_${"x".repeat(43)}`);
  assert.ok(parsed);
  assert.equal(parsed.code, "main");
  assert.equal(parsed.matchesInstance, false);
});

test("values that aren't ours are not mistaken for tokens", () => {
  for (const value of [
    "",
    "myo",
    "myo_",
    "myo_stg",
    "myo_stg_",
    "myo_stg_tooshort",
    // An OAuth access token from `malloyyo login`: 43 chars, no marker.
    "Ck1rQmJ3S2xvR2hRc3VwZXJzZWNyZXRhY2Nlc3N0b2s",
    // A MotherDuck token — the shape that used to live under this env var.
    "eyJhbGciOiJIUzI1NiJ9.eyJzZXNzaW9uIjoiYWJjIn0.sig",
    `myo_STG_${"x".repeat(43)}`, // codes are minted lowercase
  ]) {
    assert.equal(lib.looksLikeApiToken(value), false, `should not parse: ${value}`);
  }
});

test("an instance code with an underscore can't break the format", () => {
  // The code sits between two underscores, so it is stripped to alphanumerics
  // before it goes anywhere near a token.
  const saved = process.env.INSTANCE_CODE;
  process.env.INSTANCE_CODE = "east_1";
  try {
    assert.equal(lib.tokenInstanceCode(), "east1");
    const minted = lib.mintTokenValue();
    const parsed = lib.parseApiToken(minted.raw);
    assert.ok(parsed);
    assert.equal(parsed.code, "east1");
    assert.equal(parsed.matchesInstance, true);
  } finally {
    process.env.INSTANCE_CODE = saved;
  }
});

test("displayPrefix keeps a value that isn't parseable short anyway", () => {
  assert.equal(lib.displayPrefix("not-a-token-but-quite-long"), "not-a-to");
});

test("scopes: an interactive login satisfies everything, a token only what it holds", () => {
  assert.equal(lib.scopeSatisfied("all", "publish"), true);
  assert.equal(lib.scopeSatisfied("all", "mcp"), true);
  assert.equal(lib.scopeSatisfied(["publish"], "publish"), true);
  assert.equal(lib.scopeSatisfied(["publish"], "mcp"), false);
  assert.equal(lib.scopeSatisfied([], "mcp"), false);
});

test("validateScopes takes known scopes, dedupes, and orders them stably", () => {
  assert.deepEqual(lib.validateScopes(["mcp", "publish", "mcp"]), {
    ok: true,
    value: ["publish", "mcp"],
  });
  assert.equal(lib.validateScopes(["admin"]).ok, false);
  assert.equal(lib.validateScopes([]).ok, false);
  assert.equal(lib.validateScopes("publish").ok, false);
  assert.equal(lib.validateScopes(undefined).ok, false);
});

test("validateTokenName requires something, trims it, and caps the length", () => {
  assert.deepEqual(lib.validateTokenName("  github actions "), { ok: true, value: "github actions" });
  assert.equal(lib.validateTokenName("   ").ok, false);
  assert.equal(lib.validateTokenName(42).ok, false);
  assert.equal(lib.validateTokenName(undefined).ok, false);
  assert.equal(lib.validateTokenName("x".repeat(lib.MAX_TOKEN_NAME_LENGTH)).ok, true);
  assert.equal(lib.validateTokenName("x".repeat(lib.MAX_TOKEN_NAME_LENGTH + 1)).ok, false);
});

test("expiry: null means never, a day count means that many days out", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  assert.deepEqual(lib.expiryFromDays(null, now), { ok: true, value: null });
  assert.deepEqual(lib.expiryFromDays(undefined, now), { ok: true, value: null });

  const in90 = lib.expiryFromDays(90, now);
  assert.ok(in90.ok);
  assert.equal(in90.value?.toISOString(), "2026-04-01T00:00:00.000Z");

  for (const bad of [0, -1, 1.5, 3651, "90", NaN]) {
    assert.equal(lib.expiryFromDays(bad, now).ok, false, `should reject ${String(bad)}`);
  }
});

test("isExpired: a null expiry never expires", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  assert.equal(lib.isExpired({ expiresAt: null }, now), false);
  assert.equal(lib.isExpired({ expiresAt: new Date("2025-12-31T23:59:59.000Z") }, now), true);
  assert.equal(lib.isExpired({ expiresAt: new Date("2026-01-02T00:00:00.000Z") }, now), false);
});

test("the marker is the value the CLI and secret scanners match on", () => {
  // Changing this invalidates every issued token and every scanning rule —
  // this assertion exists so that can't happen by accident.
  assert.equal(lib.API_TOKEN_MARKER, "myo");
});
