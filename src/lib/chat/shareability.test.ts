// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// SECURITY TEST for publishing a chat (PATCH /api/chats/[id] { isPublic } — the
// CHAT's own flag — and the read path, both through `datasetSharesChats` →
// `shareabilityOf`).
//
// A published chat serves its STORED RESULT ROWS to every signed-in reader.
// Row scoping is per viewer, so a dataset can be open to every member — anyone
// may open it — while showing each person only their own rows. Publishing used
// to be gated on openness alone, which let one tenant hand every other
// signed-in user their own rows through a self-service toggle.
//
// "Open to every member" is the members role at full on the dataset. It used
// to be a `datasets.is_public` flag, which nothing reads any more.
//
// Hermetic: two field checks, no DB / network.
// Run: npm test   (tsx --test src/lib/**/*.test.ts)

import { test } from "node:test";
import assert from "node:assert/strict";
import { shareabilityOf } from "./shareability";

const OPEN = { roles: ["MALLOYYO_USER"], viewOnlyRoles: [] as string[] };
const CLOSED = { roles: ["analysts"], viewOnlyRoles: [] as string[] };

test("a dataset open to every member, unscoped, shares its chats", () => {
  assert.deepEqual(shareabilityOf({ ...OPEN, requiredGivens: [] }), { ok: true });
});

test("an open but ROW-SCOPED dataset does not — this is the leak", () => {
  // The multi-tenant shape: open so everyone may open it, scoped so everyone
  // sees only their own rows. The chat's stored rows are one tenant's.
  assert.deepEqual(shareabilityOf({ ...OPEN, requiredGivens: ["MALLOYYO_EMAIL"] }), {
    ok: false,
    reason: "row-scoped",
  });
});

test("a dataset that is not open to every member does not, and says so rather than scoped", () => {
  // Both conditions failing reports the more fundamental one: telling someone
  // their open dataset is scoped is useful; telling them their closed dataset
  // is scoped sends them to the wrong setting.
  assert.deepEqual(shareabilityOf({ ...CLOSED, requiredGivens: ["MALLOYYO_EMAIL"] }), {
    ok: false,
    reason: "not-public",
  });
  assert.deepEqual(shareabilityOf({ ...CLOSED, requiredGivens: [] }), {
    ok: false,
    reason: "not-public",
  });
});

test("the members role at dashboards-only is not open: a shared chat carries rows", () => {
  assert.deepEqual(
    shareabilityOf({ roles: ["MALLOYYO_USER"], viewOnlyRoles: ["MALLOYYO_USER"], requiredGivens: [] }),
    { ok: false, reason: "not-public" },
  );
});

test("nulls fail closed", () => {
  // The role arrays are NOT NULL in the schema and `required_givens` defaults
  // to '{}', but a gate reads defensively: neither null roles nor null givens
  // may read as permission.
  assert.equal(shareabilityOf({ roles: null, viewOnlyRoles: null, requiredGivens: null }).ok, false);
  assert.deepEqual(shareabilityOf({ ...OPEN, requiredGivens: null }), { ok: true });
});

test("the result is only usable via .ok — a truthiness check would pass everything", () => {
  // The caller bug this shape is meant to make obvious: `if (!result)` against
  // a returned object is always false, so the gate would be permanently open
  // and TypeScript would be satisfied. Every variant is truthy; only `.ok`
  // distinguishes them.
  for (const ds of [
    { ...OPEN, requiredGivens: [] },
    { ...OPEN, requiredGivens: ["MALLOYYO_EMAIL"] },
    { ...CLOSED, requiredGivens: [] },
  ]) {
    assert.ok(shareabilityOf(ds), "every variant is a truthy object");
  }
  assert.equal(shareabilityOf({ ...OPEN, requiredGivens: ["x"] }).ok, false);
});
