// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT
//
// The roster rules behind the admin Users tab (src/lib/roster.ts), against a
// real Postgres: transition guards, owner protection, no self-revocation, and
// the invitation flows — including "inviting someone already waiting approves
// them", which is the queue and the invite path meeting in the middle.
//
// Run via `npm run test:hosted` (scripts/hosted-test.sh stands up Postgres,
// pushes the schema, and runs this with DATABASE_URL pointed at it).

import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { accounts, db, invitations, roles, users, type User } from "@/db";
import { addUser, applyUserAction, removeAddedUser, RosterError } from "@/lib/roster";
import { deleteRole } from "@/lib/roles";
import { claimAddedUser, emailIsTrusted, providersThatCannotClaim } from "@/lib/claim";

async function resetData() {
  await db.delete(users);
  await db.delete(invitations);
}

async function seedUser(overrides: Partial<typeof users.$inferInsert> = {}): Promise<User> {
  const [u] = await db.insert(users).values({ status: "active", ...overrides }).returning();
  return u;
}

let owner: User;
let admin: User;

beforeEach(async () => {
  await resetData();
  owner = await seedUser({ email: "owner@example.com", role: "owner", isAdmin: true });
  admin = await seedUser({ email: "admin@example.com", role: "admin", isAdmin: true });
});

test("the queue: approve activates, deny disables, and only pending rows qualify", async () => {
  const newcomer = await seedUser({ email: "new1@example.com", status: "pending" });
  const approved = await applyUserAction(admin, newcomer.id, "approve");
  assert.equal(approved.status, "active");
  await assert.rejects(applyUserAction(admin, newcomer.id, "approve"), RosterError, "stale approve refused");

  const other = await seedUser({ email: "new2@example.com", status: "pending" });
  const denied = await applyUserAction(admin, other.id, "deny");
  assert.equal(denied.status, "disabled");
});

test("disable ⇄ enable, promote ⇄ demote (isAdmin mirrors role)", async () => {
  const m = await seedUser({ email: "m@example.com" });
  assert.equal((await applyUserAction(admin, m.id, "disable")).status, "disabled");
  assert.equal((await applyUserAction(admin, m.id, "enable")).status, "active");
  const promoted = await applyUserAction(admin, m.id, "promote");
  assert.equal(promoted.role, "admin");
  assert.equal(promoted.isAdmin, true);
  const demoted = await applyUserAction(admin, m.id, "demote");
  assert.equal(demoted.role, "member");
  assert.equal(demoted.isAdmin, false);
});

test("an owner is untouchable through this surface", async () => {
  for (const action of ["disable", "demote", "deny"] as const) {
    await assert.rejects(applyUserAction(admin, owner.id, action), RosterError);
  }
  const [check] = await db.select().from(users).where(eq(users.id, owner.id));
  assert.equal(check.status, "active");
  assert.equal(check.role, "owner");
});

test("you cannot revoke your own access or role", async () => {
  await assert.rejects(applyUserAction(admin, admin.id, "disable"), RosterError);
  await assert.rejects(applyUserAction(admin, admin.id, "demote"), RosterError);
});

// --- Add user: an address, and the roles that person starts with -------------
//
// It creates the USER. There is no invitation: from the moment they are added
// they are a row like anyone else — roles, dashboard shares, impersonation —
// marked as not having signed in, and their first sign-in claims that row.

test("adding someone creates them: active, holding exactly the ticked roles, not yet signed in", async () => {
  await db.insert(roles).values({ name: "analysts" }).onConflictDoNothing();
  const out = await addUser(admin, " Colleague@Example.com ", ["MALLOYYO_USER", "analysts"]);
  assert.equal(out.kind, "added");
  assert.equal(out.user.email, "colleague@example.com", "stored lowercase");
  assert.equal(out.user.status, "active");
  assert.deepEqual(out.user.roles, ["MALLOYYO_USER", "analysts"]);
  assert.equal(out.user.firstSignedInAt, null, "added, not arrived");
  assert.equal(out.user.addedById, admin.id);
  assert.equal(out.user.role, "member");
  assert.equal((await db.select().from(invitations)).length, 0, "no invitation is written");

  // The admin role and the two legacy admin columns are one fact.
  const boss = await addUser(admin, "boss@example.com", ["MALLOYYO_ADMIN"]);
  assert.equal(boss.user.role, "admin");
  assert.equal(boss.user.isAdmin, true);

  // Someone already added is not added twice — whatever the case of the address.
  await assert.rejects(addUser(admin, "COLLEAGUE@example.com", ["analysts"]), /already added/);
  // Nobody at all is a choice an admin may make: they sign in to an empty page.
  const bare = await addUser(admin, "bare@example.com", []);
  assert.deepEqual(bare.user.roles, []);
  await db.delete(roles).where(eq(roles.name, "analysts"));
});

test("adding someone who is already waiting approves them with the ticked roles", async () => {
  await db.insert(roles).values({ name: "analysts" }).onConflictDoNothing();
  const waiting = await seedUser({ email: "queue@example.com", status: "pending", roles: ["MALLOYYO_USER"] });
  const outcome = await addUser(admin, "queue@example.com", ["analysts"]);
  assert.equal(outcome.kind, "approved");
  const [row] = await db.select().from(users).where(eq(users.id, waiting.id));
  assert.equal(row.status, "active");
  assert.deepEqual(row.roles, ["analysts"], "what was ticked, not what the row happened to hold");
  assert.equal((await db.select().from(users).where(eq(users.email, "queue@example.com"))).length, 1, "the same row");
  await db.delete(roles).where(eq(roles.name, "analysts"));
});

test("adding an active or disabled address is refused with a pointer to the right action", async () => {
  await assert.rejects(addUser(admin, "admin@example.com", []), /already an active user/);
  await seedUser({ email: "off@example.com", status: "disabled" });
  await assert.rejects(addUser(admin, "off@example.com", []), /enable them instead/);
});

test("junk addresses and unknown roles are refused", async () => {
  await assert.rejects(addUser(admin, "not-an-email", []), RosterError);
  await assert.rejects(addUser(admin, "typo@example.com", ["analists"]), /unknown role/);
  assert.equal((await db.select().from(users).where(eq(users.email, "typo@example.com"))).length, 0);
});

test("removing takes back someone added who has not signed in — and only them", async () => {
  const added = await addUser(admin, "gone@example.com", ["MALLOYYO_USER"]);
  await removeAddedUser(admin, added.user.id);
  assert.equal((await db.select().from(users).where(eq(users.id, added.user.id))).length, 0);
  await assert.rejects(removeAddedUser(admin, added.user.id), RosterError, "already gone");

  // Someone who has signed in is disabled, never removed: their history,
  // drafts and chats hang off the row.
  const here = await seedUser({ email: "here@example.com" });
  await assert.rejects(removeAddedUser(admin, here.id), /disabled, not removed/);
  assert.equal((await db.select().from(users).where(eq(users.id, here.id))).length, 1);
});

// A deleted role must not survive on someone who has not arrived yet. They are
// a users row now, so the ordinary sweep covers them — which is the point.
test("deleting a role takes it off people who were added and have not signed in", async () => {
  await db.insert(roles).values({ name: "contractors" }).onConflictDoNothing();
  const late = await addUser(admin, "late@example.com", ["MALLOYYO_USER", "contractors"]);
  await deleteRole("contractors");
  const [row] = await db.select().from(users).where(eq(users.id, late.user.id));
  assert.deepEqual(row.roles, ["MALLOYYO_USER"]);
});

// --- the first sign-in claims the row (src/lib/claim.ts) ---------------------

const googleAccount = (id: string) => ({ provider: "google", providerAccountId: id, type: "oidc" });

test("a first sign-in claims the row that was added for that address", async () => {
  const added = await addUser(admin, "arriving@example.com", ["MALLOYYO_USER"]);
  const claimed = await claimAddedUser({
    email: "Arriving@Example.com", // as a provider may well spell it
    account: googleAccount("g-1"),
    trusted: true,
    name: "Arri Ving",
  });
  assert.equal(claimed, added.user.id, "the SAME row, not a second person");
  const [row] = await db.select().from(users).where(eq(users.id, added.user.id));
  assert.ok(row.firstSignedInAt, "they have signed in now");
  assert.equal(row.name, "Arri Ving");
  assert.deepEqual(row.roles, ["MALLOYYO_USER"], "holding exactly what was ticked");
  const linked = await db.select().from(accounts).where(eq(accounts.userId, added.user.id));
  assert.deepEqual(linked.map((a) => [a.provider, a.providerAccountId]), [["google", "g-1"]]);

  // Signing in again is an ordinary returning sign-in: nothing to claim.
  assert.equal(await claimAddedUser({ email: "arriving@example.com", account: googleAccount("g-1"), trusted: true }), null);
});

test("only a row that has NEVER signed in can be claimed", async () => {
  // An established account must never be attached to by address: that is the
  // account takeover Auth.js refuses, and this must not reintroduce it.
  const established = await seedUser({ email: "old-hand@example.com" });
  assert.equal(
    await claimAddedUser({ email: "old-hand@example.com", account: googleAccount("g-intruder"), trusted: true }),
    null,
  );
  assert.equal((await db.select().from(accounts).where(eq(accounts.userId, established.id))).length, 0);

  // A row already claimed cannot be claimed by a second provider account.
  const added = await addUser(admin, "once@example.com", []);
  assert.equal(await claimAddedUser({ email: "once@example.com", account: googleAccount("g-a"), trusted: true }), added.user.id);
  assert.equal(await claimAddedUser({ email: "once@example.com", account: googleAccount("g-b"), trusted: true }), null);
  assert.equal((await db.select().from(accounts).where(eq(accounts.userId, added.user.id))).length, 1);
});

test("a provider whose word for the address is not trusted claims nothing", async () => {
  const added = await addUser(admin, "target@example.com", ["MALLOYYO_ADMIN"]);
  assert.equal(
    await claimAddedUser({ email: "target@example.com", account: { provider: "microsoft-entra-id", providerAccountId: "x", type: "oidc" }, trusted: false }),
    null,
  );
  const [row] = await db.select().from(users).where(eq(users.id, added.user.id));
  assert.equal(row.firstSignedInAt, null, "still waiting for the real person");
  assert.equal((await db.select().from(accounts)).length, 0);

  // Nor a disabled row, nor a sign-in with no address.
  await applyUserAction(admin, added.user.id, "disable");
  assert.equal(await claimAddedUser({ email: "target@example.com", account: googleAccount("g-9"), trusted: true }), null);
  assert.equal(await claimAddedUser({ email: null, account: googleAccount("g-10"), trusted: true }), null);
});

test("which providers are trusted for an address", () => {
  const saved = process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER;
  try {
    assert.equal(emailIsTrusted("google", { email_verified: true }), true);
    assert.equal(emailIsTrusted("google", { email_verified: false }), false);
    assert.equal(emailIsTrusted("google", {}), false, "Google has to say so");
    assert.equal(emailIsTrusted("okta", {}), true, "the organization's own directory");
    assert.equal(emailIsTrusted("okta", { email_verified: false }), false);
    // Microsoft: only when sign-in is restricted to one tenant. With the common
    // authority any tenant's admin can set a user's mail to anything.
    delete process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER;
    assert.equal(emailIsTrusted("microsoft-entra-id", { email: "x@y.com" }), false);
    assert.deepEqual(providersThatCannotClaim(["google", "microsoft-entra-id"]), ["microsoft-entra-id"]);
    process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER = "https://login.microsoftonline.com/tenant/v2.0/";
    assert.equal(emailIsTrusted("microsoft-entra-id", {}), true);
    assert.deepEqual(providersThatCannotClaim(["google", "microsoft-entra-id"]), []);
    // A provider is trusted by being named, never by default.
    assert.equal(emailIsTrusted("github", { email_verified: true }), false);
  } finally {
    if (saved === undefined) delete process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER;
    else process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER = saved;
  }
});
