// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The authorization seam, as it behaves in this build.
//
// No authentication integration is installed here — hostedSignIn() answers "no"
// and that answer is compiled in — so authorize() takes the users-table branch.
// The hosted branch (provider admits, the local `disabled` mirror denies) is a
// pure function over the row, so it is pinned directly.
//
// Run: npm test

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { User } from "@/db";
import { authorize, hostedAuthorize, ossAuthorize } from "./authorize.js";
import { hostedSignIn } from "./hosted-auth-integration.js";

const SAVED = process.env.BREAK_GLASS_EMAIL;
afterEach(() => {
  if (SAVED === undefined) delete process.env.BREAK_GLASS_EMAIL;
  else process.env.BREAK_GLASS_EMAIL = SAVED;
});

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Test User",
    email: "person@example.com",
    emailVerified: null,
    image: null,
    isAdmin: false,
    status: "active",
    role: "member",
    externalAccountId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

// The premise the rest of the suite rests on: with no integration installed,
// authorize() IS the users-table implementation.
test("this build has no authentication integration, so authorize() is the OSS branch", () => {
  delete process.env.BREAK_GLASS_EMAIL;
  assert.equal(hostedSignIn(), false);
  assert.deepEqual(authorize(makeUser({ status: "pending" })), ossAuthorize(makeUser({ status: "pending" })));
});

test("active is allowed, with the row's role", () => {
  delete process.env.BREAK_GLASS_EMAIL;
  assert.deepEqual(ossAuthorize(makeUser()), { allowed: true, role: "member" });
  assert.deepEqual(ossAuthorize(makeUser({ role: "owner" })), { allowed: true, role: "owner" });
});

test("pending and disabled are refused, and say which", () => {
  delete process.env.BREAK_GLASS_EMAIL;
  assert.deepEqual(ossAuthorize(makeUser({ status: "pending" })), { allowed: false, reason: "pending" });
  assert.deepEqual(ossAuthorize(makeUser({ status: "disabled" })), { allowed: false, reason: "disabled" });
});

test("break-glass admits its address regardless of row state, as admin", () => {
  // The door's whole job: let the operator back in when the data says no.
  process.env.BREAK_GLASS_EMAIL = "Operator@Example.com";
  const disabled = makeUser({ email: "operator@example.com", status: "disabled" });
  assert.deepEqual(ossAuthorize(disabled), { allowed: true, role: "admin", breakGlass: true });
  // Case-insensitive on both sides.
  const pending = makeUser({ email: "OPERATOR@example.com", status: "pending" });
  assert.equal(ossAuthorize(pending).allowed, true);
});

test("break-glass opens the instance, it does not transfer it — an owner keeps owner", () => {
  process.env.BREAK_GLASS_EMAIL = "operator@example.com";
  const owner = makeUser({ email: "operator@example.com", role: "owner", status: "disabled" });
  assert.deepEqual(ossAuthorize(owner), { allowed: true, role: "owner", breakGlass: true });
});

test("break-glass admits nobody else, and an unset or blank door is closed", () => {
  process.env.BREAK_GLASS_EMAIL = "operator@example.com";
  assert.equal(ossAuthorize(makeUser({ email: "stranger@example.com", status: "disabled" })).allowed, false);
  process.env.BREAK_GLASS_EMAIL = "   ";
  assert.equal(ossAuthorize(makeUser({ email: "operator@example.com", status: "disabled" })).allowed, false);
  delete process.env.BREAK_GLASS_EMAIL;
  assert.equal(ossAuthorize(makeUser({ email: "operator@example.com", status: "disabled" })).allowed, false);
});

test("a row with no email can never match the break-glass door", () => {
  process.env.BREAK_GLASS_EMAIL = "operator@example.com";
  assert.equal(ossAuthorize(makeUser({ email: null, status: "disabled" })).allowed, false);
});

// --- the hosted branch: the provider admits, we deny --------------------------

test("hosted: only disabled refuses; the provider's admission stands otherwise", () => {
  assert.deepEqual(hostedAuthorize(makeUser()), { allowed: true, role: "member" });
  // No approval queue on such a deployment: a row the provider minted is in.
  assert.deepEqual(hostedAuthorize(makeUser({ status: "pending" })), { allowed: true, role: "member" });
  assert.deepEqual(hostedAuthorize(makeUser({ status: "disabled" })), { allowed: false, reason: "disabled" });
});

test("hosted: a session with no email is untouched by any list — admission is the row", () => {
  // The bug the seam retires: an env-var list keyed on email refused exactly
  // the sessions that carry no address. The hosted branch never reads one.
  process.env.BREAK_GLASS_EMAIL = "operator@example.com";
  assert.equal(hostedAuthorize(makeUser({ email: null })).allowed, true);
});
