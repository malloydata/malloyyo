// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// SECURITY TEST for publishing a chat (PATCH /api/chats/[id] { isPublic } and
// the read path, both through `datasetSharesChats` → `shareabilityOf`).
//
// A published chat serves its STORED RESULT ROWS to every signed-in reader.
// Row scoping is per viewer, so a dataset can be public — anyone may open it —
// while showing each person only their own rows. Publishing used to be gated on
// `is_public` alone, which let one tenant hand every other signed-in user their
// own rows through a self-service toggle.
//
// Hermetic: two field checks, no DB / network.
// Run: npm test   (tsx --test src/lib/**/*.test.ts)

import { test } from "node:test";
import assert from "node:assert/strict";
import { shareabilityOf } from "./shareability";

test("a public, unscoped dataset shares its chats", () => {
  assert.deepEqual(shareabilityOf({ isPublic: true, requiredGivens: [] }), { ok: true });
});

test("a public but ROW-SCOPED dataset does not — this is the leak", () => {
  // The multi-tenant shape: public so everyone may open it, scoped so everyone
  // sees only their own rows. The chat's stored rows are one tenant's.
  assert.deepEqual(shareabilityOf({ isPublic: true, requiredGivens: ["MALLOYYO_EMAIL"] }), {
    ok: false,
    reason: "row-scoped",
  });
});

test("a private dataset does not, and says private rather than scoped", () => {
  // Both conditions failing reports the more fundamental one: telling someone
  // their public dataset is scoped is useful; telling them their private
  // dataset is scoped sends them to the wrong setting.
  assert.deepEqual(shareabilityOf({ isPublic: false, requiredGivens: ["MALLOYYO_EMAIL"] }), {
    ok: false,
    reason: "not-public",
  });
  assert.deepEqual(shareabilityOf({ isPublic: false, requiredGivens: [] }), {
    ok: false,
    reason: "not-public",
  });
});

test("nulls fail closed", () => {
  // `is_public` is NOT NULL in the schema and `required_givens` defaults to
  // '{}', but a gate reads defensively: neither a null flag nor null givens may
  // read as permission.
  assert.equal(shareabilityOf({ isPublic: null, requiredGivens: null }).ok, false);
  assert.deepEqual(shareabilityOf({ isPublic: true, requiredGivens: null }), { ok: true });
});

test("the result is only usable via .ok — a truthiness check would pass everything", () => {
  // The caller bug this shape is meant to make obvious: `if (!result)` against
  // a returned object is always false, so the gate would be permanently open
  // and TypeScript would be satisfied. Every variant is truthy; only `.ok`
  // distinguishes them.
  for (const ds of [
    { isPublic: true, requiredGivens: [] },
    { isPublic: true, requiredGivens: ["MALLOYYO_EMAIL"] },
    { isPublic: false, requiredGivens: [] },
  ]) {
    assert.ok(shareabilityOf(ds), "every variant is a truthy object");
  }
  assert.equal(shareabilityOf({ isPublic: true, requiredGivens: ["x"] }).ok, false);
});
