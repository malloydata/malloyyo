// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT
//
// The load-bearing halves of the access-control upgrade, against a real
// Postgres: the one-time EMAIL_ALLOW_LIST seeding (src/lib/access-upgrade.ts,
// run by runMigrations after the journal applies) and the admission decision
// for new sign-ins (src/lib/admission.ts).
//
// A just-upgraded legacy database is simulated by DATA, which is exactly what
// it is at that moment: the journal has added the columns, so every existing
// row sits at the fail-closed default (`pending`, `member`) and no access
// policy is recorded. Seeding decides from there.
//
// The seeding rules are the ones that must not soften on upgrade:
//   * every existing row NOT on the list lands `disabled` — those people are
//     refused on every request today, and marking them active would grant
//     access to exactly the population the list was excluding;
//   * listed addresses with no row yet become open invitations, so people
//     admitted but not yet arrived are not silently dropped;
//   * seeding runs once per database — data-guarded, so neither a second boot
//     nor a hand re-run can re-decide anything.
//
// Run via `npm run test:hosted` (scripts/hosted-test.sh stands up Postgres,
// pushes the schema, and runs this with DATABASE_URL pointed at it).

import test, { after } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { asc, eq } from "drizzle-orm";
import { db, instanceSettings, invitations, users } from "@/db";
import { seedAccessControl } from "@/lib/access-upgrade";
import { admitNewUser } from "@/lib/admission";

const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
after(async () => {
  await sql.end({ timeout: 5 });
});

async function resetData() {
  await sql`DELETE FROM users`;
  await sql`DELETE FROM invitations`;
  await sql`DELETE FROM instance_settings`;
}

/** A row as it looks the moment the journal upgraded a legacy database: the
    fail-closed defaults, decided by nobody. */
async function insertLegacyUser(email: string | null, isAdmin: boolean, createdAt: string) {
  await sql`
    INSERT INTO users (email, is_admin, created_at, status, role)
    VALUES (${email}, ${isAdmin}, ${createdAt}, 'pending', 'member')`;
}

async function userByEmail(email: string) {
  const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  assert.ok(u, `expected a users row for ${email}`);
  return u;
}

test("upgrade with a list: listed→active, unlisted→disabled, missing→invited, policy=invite", async () => {
  await resetData();
  // alice: earliest admin, on the list. bob: ordinary member, on the list.
  // carol: NOT on the list — she is refused today and must stay refused.
  // dave: no email at all — cannot match a list, so he is refused today too.
  await insertLegacyUser("alice@example.com", true, "2026-01-01T00:00:00Z");
  await insertLegacyUser("bob@example.com", false, "2026-01-02T00:00:00Z");
  await insertLegacyUser("carol@example.com", false, "2026-01-03T00:00:00Z");
  await insertLegacyUser(null, false, "2026-01-04T00:00:00Z");

  await seedAccessControl(sql, {
    // Mixed case and stray spaces, as env vars are actually written.
    allowList: "Alice@example.com , bob@example.com, eve@example.com",
    instanceCode: "main",
  });

  assert.equal((await userByEmail("alice@example.com")).status, "active");
  assert.equal((await userByEmail("alice@example.com")).role, "owner", "earliest active admin becomes owner");
  assert.equal((await userByEmail("bob@example.com")).status, "active");
  assert.equal((await userByEmail("bob@example.com")).role, "member");
  assert.equal((await userByEmail("carol@example.com")).status, "disabled");
  const noEmail = (await db.select().from(users)).find((u) => u.email === null);
  assert.equal(noEmail?.status, "disabled");

  const invites = await db.select().from(invitations).orderBy(asc(invitations.email));
  assert.deepEqual(invites.map((i) => i.email), ["eve@example.com"], "only the not-yet-arrived get invitations");
  assert.equal(invites[0].acceptedAt, null);

  const [policy] = await db.select().from(instanceSettings).where(eq(instanceSettings.instanceCode, "main"));
  assert.equal(policy.accessPolicy, "invite");
});

test("seeding is once per database: a re-run (even with a different list) re-decides nothing", async () => {
  // Continues from the previous state. A second boot with carol added to the
  // list must NOT activate her — edits to the variable do nothing, which is
  // exactly what the startup warning exists to say.
  await seedAccessControl(sql, {
    allowList: "alice@example.com,bob@example.com,carol@example.com",
    instanceCode: "main",
  });
  assert.equal((await userByEmail("carol@example.com")).status, "disabled");
});

test("upgrade with no list: every existing row active, policy recorded as open", async () => {
  await resetData();
  await insertLegacyUser("solo@example.com", false, "2026-01-01T00:00:00Z");
  await insertLegacyUser("pal@example.com", false, "2026-01-02T00:00:00Z");

  await seedAccessControl(sql, { allowList: undefined, instanceCode: "main" });

  assert.equal((await userByEmail("solo@example.com")).status, "active");
  assert.equal((await userByEmail("pal@example.com")).status, "active");
  // No admins existed, so nobody is invented as one.
  assert.equal((await userByEmail("solo@example.com")).role, "member");
  const [policy] = await db.select().from(instanceSettings).where(eq(instanceSettings.instanceCode, "main"));
  assert.equal(policy.accessPolicy, "open");
});

test("a fresh database (no users) seeds nothing — first sign-in will bootstrap instead", async () => {
  await resetData();
  await seedAccessControl(sql, { allowList: "someone@example.com", instanceCode: "main" });
  const [policy] = await db.select().from(instanceSettings).where(eq(instanceSettings.instanceCode, "main"));
  assert.equal(policy, undefined, "no policy row recorded");
  assert.equal((await db.select().from(invitations)).length, 0);
});

test("an instance where anyone has been decided is never re-seeded", async () => {
  // The guard the boot path leans on: one active row (a fresh install's owner,
  // an admin's approval — anything) closes seeding forever, even with a list
  // set and no policy row.
  await resetData();
  await db.insert(users).values({ email: "owner@example.com", status: "active", role: "owner" });
  await insertLegacyUser("late@example.com", false, "2026-02-01T00:00:00Z");
  await seedAccessControl(sql, { allowList: "late@example.com", instanceCode: "main" });
  assert.equal((await userByEmail("late@example.com")).status, "pending", "left for the queue, not seeded");
  assert.equal((await db.select().from(instanceSettings)).length, 0);
});

// --- admission: what happens to a brand-new row ------------------------------

async function insertNewUser(email: string | null): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email })
    .returning();
  return u.id;
}

test("bootstrap: the first sign-in on an empty instance becomes the active owner", async () => {
  await resetData();
  const id = await insertNewUser("founder@example.com");
  await admitNewUser(id, "founder@example.com");
  const u = await userByEmail("founder@example.com");
  assert.equal(u.status, "active");
  assert.equal(u.role, "owner");
});

test("bootstrap never fires on an established instance — even one with no owner", async () => {
  // e.g. migrated from the allow-list era with admins coming from
  // APP_ADMIN_EMAILS: active members exist, no owner row. Whoever signs in
  // next must NOT inherit the instance.
  await resetData();
  await db.insert(users).values({ email: "resident@example.com", status: "active" });
  const id = await insertNewUser("newcomer@example.com");
  await admitNewUser(id, "newcomer@example.com");
  const u = await userByEmail("newcomer@example.com");
  assert.equal(u.status, "pending", "invite is the default policy");
  assert.equal(u.role, "member");
});

test("an open invitation admits on arrival and is consumed, carrying its role", async () => {
  await resetData();
  await db.insert(users).values({ email: "owner@example.com", status: "active", role: "owner" });
  await db.insert(invitations).values({ email: "consultant@example.com", role: "admin" });

  const id = await insertNewUser("consultant@example.com");
  await admitNewUser(id, "Consultant@Example.com"); // arrives with different casing
  const u = await userByEmail("consultant@example.com");
  assert.equal(u.status, "active");
  assert.equal(u.role, "admin");

  const [inv] = await db.select().from(invitations).where(eq(invitations.email, "consultant@example.com"));
  assert.ok(inv.acceptedAt, "invitation consumed");
  assert.equal(inv.acceptedById, id);
});

test("policy open admits a stranger as an ordinary member; policy invite leaves them pending", async () => {
  await resetData();
  await db.insert(users).values({ email: "owner@example.com", status: "active", role: "owner" });
  await db.insert(instanceSettings).values({ instanceCode: "main", accessPolicy: "open" });

  const openId = await insertNewUser("walkin@example.com");
  await admitNewUser(openId, "walkin@example.com");
  assert.equal((await userByEmail("walkin@example.com")).status, "active");
  assert.equal((await userByEmail("walkin@example.com")).role, "member");

  await db.update(instanceSettings).set({ accessPolicy: "invite" }).where(eq(instanceSettings.instanceCode, "main"));
  const inviteId = await insertNewUser("uninvited@example.com");
  await admitNewUser(inviteId, "uninvited@example.com");
  assert.equal((await userByEmail("uninvited@example.com")).status, "pending");
});
