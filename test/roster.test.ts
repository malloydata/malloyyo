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
import { eq, isNull, and } from "drizzle-orm";
import { db, invitations, roles, users, type User } from "@/db";
import { applyUserAction, createInvitation, revokeInvitation, RosterError } from "@/lib/roster";
import { deleteRole } from "@/lib/roles";
import { admitNewUser } from "@/lib/admission";

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

test("inviting a fresh address creates one open invitation; re-inviting updates its role", async () => {
  const first = await createInvitation(admin, " Colleague@Example.com ", "member");
  assert.equal(first.kind, "invited");
  assert.ok(first.kind === "invited" && first.invitation.email === "colleague@example.com", "normalized");

  const again = await createInvitation(admin, "colleague@example.com", "admin");
  assert.ok(again.kind === "invited" && again.invitation.role === "admin");
  const open = await db.select().from(invitations).where(isNull(invitations.acceptedAt));
  assert.equal(open.length, 1, "still one open invitation");
});

test("inviting someone already waiting approves them with the invited role", async () => {
  const waiting = await seedUser({ email: "wait@example.com", status: "pending" });
  const outcome = await createInvitation(admin, "wait@example.com", "admin");
  assert.equal(outcome.kind, "approved");
  const [row] = await db.select().from(users).where(eq(users.id, waiting.id));
  assert.equal(row.status, "active");
  assert.equal(row.role, "admin");
  assert.equal((await db.select().from(invitations)).length, 0, "no invitation row minted");
});

// Admin → Users → Add user: the roles ticked there are what the person starts
// with. An invitation that carries none still means "the instance default".
test("adding someone with roles stores exactly those; the admin role and the admin flag move together", async () => {
  await db.insert(roles).values({ name: "analysts" }).onConflictDoNothing();

  const plain = await createInvitation(admin, "plain@example.com", "member");
  assert.ok(plain.kind === "invited" && plain.invitation.roles === null, "nobody chose roles");

  const chosen = await createInvitation(admin, "pick@example.com", "member", ["MALLOYYO_USER", "analysts"]);
  assert.ok(chosen.kind === "invited");
  assert.deepEqual(chosen.kind === "invited" && chosen.invitation.roles, ["MALLOYYO_USER", "analysts"]);
  assert.equal(chosen.kind === "invited" && chosen.invitation.role, "member");

  // Ticking MALLOYYO_ADMIN is the same fact as the legacy flag, said once.
  const boss = await createInvitation(admin, "boss@example.com", "member", ["MALLOYYO_ADMIN"]);
  assert.equal(boss.kind === "invited" && boss.invitation.role, "admin");
  const flagged = await createInvitation(admin, "flag@example.com", "admin", ["analysts"]);
  assert.deepEqual(flagged.kind === "invited" && flagged.invitation.roles, ["analysts", "MALLOYYO_ADMIN"]);

  // Re-adding with different ticks replaces them; without any, leaves them.
  const again = await createInvitation(admin, "pick@example.com", "member", ["MALLOYYO_USER"]);
  assert.deepEqual(again.kind === "invited" && again.invitation.roles, ["MALLOYYO_USER"]);
  const untouched = await createInvitation(admin, "pick@example.com", "member");
  assert.deepEqual(untouched.kind === "invited" && untouched.invitation.roles, ["MALLOYYO_USER"]);

  await assert.rejects(createInvitation(admin, "typo@example.com", "member", ["analists"]), /unknown role/);
  await db.delete(roles).where(eq(roles.name, "analysts"));
});

// The older request body carries only `role`. Changing an invitation from admin
// to member that way used to leave MALLOYYO_ADMIN in the stored roles, which
// admission copies onto the user: a "member" who arrived an admin.
test("changing an invitation's admin flag moves the admin role with it", async () => {
  await db.insert(roles).values({ name: "analysts" }).onConflictDoNothing();
  await createInvitation(admin, "boss@example.com", "member", ["analysts", "MALLOYYO_ADMIN"]);

  const demoted = await createInvitation(admin, "boss@example.com", "member");
  assert.ok(demoted.kind === "invited");
  assert.equal(demoted.kind === "invited" && demoted.invitation.role, "member");
  assert.deepEqual(demoted.kind === "invited" && demoted.invitation.roles, ["analysts"], "the admin role went with the flag");

  // And arriving on it makes a member, not an admin.
  const [arrived] = await db.insert(users).values({ email: "boss@example.com" }).returning();
  await admitNewUser(arrived.id, "boss@example.com");
  const [row] = await db.select().from(users).where(eq(users.id, arrived.id));
  assert.deepEqual(row.roles, ["analysts"]);
  assert.equal(row.role, "member");
  assert.equal(row.isAdmin, false);

  // The other direction: the flag set to admin adds the role.
  await createInvitation(admin, "up@example.com", "member", ["analysts"]);
  const promoted = await createInvitation(admin, "up@example.com", "admin");
  assert.deepEqual(promoted.kind === "invited" && promoted.invitation.roles, ["analysts", "MALLOYYO_ADMIN"]);
  await db.delete(roles).where(eq(roles.name, "analysts"));
});

// A deleted role must not survive on someone who has not arrived yet.
test("deleting a role takes it off open invitations, so nobody arrives holding it", async () => {
  await db.insert(roles).values({ name: "contractors" }).onConflictDoNothing();
  await createInvitation(admin, "late@example.com", "member", ["MALLOYYO_USER", "contractors"]);
  const holder = await seedUser({ email: "holder@example.com", roles: ["contractors"] });

  await deleteRole("contractors");

  const [inv] = await db.select().from(invitations).where(eq(invitations.email, "late@example.com"));
  assert.deepEqual(inv.roles, ["MALLOYYO_USER"]);
  const [held] = await db.select().from(users).where(eq(users.id, holder.id));
  assert.deepEqual(held.roles, [], "and off the people who held it, as before");

  const [arrived] = await db.insert(users).values({ email: "late@example.com" }).returning();
  await admitNewUser(arrived.id, "late@example.com");
  const [row] = await db.select().from(users).where(eq(users.id, arrived.id));
  assert.deepEqual(row.roles, ["MALLOYYO_USER"]);
});

test("adding someone who is already waiting approves them with the ticked roles", async () => {
  await db.insert(roles).values({ name: "analysts" }).onConflictDoNothing();
  const waiting = await seedUser({ email: "queue@example.com", status: "pending", roles: ["MALLOYYO_USER"] });
  const outcome = await createInvitation(admin, "queue@example.com", "member", ["analysts"]);
  assert.equal(outcome.kind, "approved");
  const [row] = await db.select().from(users).where(eq(users.id, waiting.id));
  assert.equal(row.status, "active");
  assert.deepEqual(row.roles, ["analysts"], "what was ticked, not what the row happened to hold");
  await db.delete(roles).where(eq(roles.name, "analysts"));
});

test("inviting an active or disabled address is refused with a pointer to the right action", async () => {
  await assert.rejects(createInvitation(admin, "admin@example.com", "member"), /already an active user/);
  await seedUser({ email: "off@example.com", status: "disabled" });
  await assert.rejects(createInvitation(admin, "off@example.com", "member"), /enable them instead/);
});

test("junk addresses and junk roles are refused", async () => {
  await assert.rejects(createInvitation(admin, "not-an-email", "member"), RosterError);
  // The route already narrows role; this is the lib refusing an owner invite.
  await assert.rejects(createInvitation(admin, "x@example.com", "owner"), RosterError);
});

test("revoke deletes an open invitation and refuses a consumed or unknown one", async () => {
  const created = await createInvitation(admin, "gone@example.com", "member");
  assert.equal(created.kind, "invited");
  const id = created.kind === "invited" ? created.invitation.id : "";
  await revokeInvitation(admin, id);
  assert.equal((await db.select().from(invitations)).length, 0);
  await assert.rejects(revokeInvitation(admin, id), RosterError);

  // A consumed invitation is history, not revocable.
  const [consumed] = await db
    .insert(invitations)
    .values({ email: "done@example.com", acceptedAt: new Date() })
    .returning();
  await assert.rejects(revokeInvitation(admin, consumed.id), RosterError);
  const [still] = await db
    .select()
    .from(invitations)
    .where(and(eq(invitations.id, consumed.id), isNull(invitations.acceptedAt)));
  assert.equal(still, undefined);
});
