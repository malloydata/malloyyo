// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT
//
// The membership-mirror capabilities the application lends an authentication
// integration (src/lib/external-user.ts), against a real Postgres. These are
// lent — called by code the application does not own — so their contract is
// pinned against the real store:
//
//   setExternalUserDisabled — the §6.4 revocation mirror. Disable always lands;
//   re-enable ONLY reverses a disable, and neither invents a row.
//
//   externalUserFacts — read-only, batched app-side facts for the roster.
//
// Run via `npm run test:hosted` (scripts/hosted-test.sh stands up Postgres,
// pushes the schema, and runs this with DATABASE_URL pointed at it).

import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, datasets, history, users } from "@/db";
import { externalUserFacts, setExternalUserDisabled } from "@/lib/external-user";

beforeEach(async () => {
  await db.delete(users);
});

async function seed(externalAccountId: string, overrides: Partial<typeof users.$inferInsert> = {}) {
  const [u] = await db
    .insert(users)
    .values({ externalAccountId, status: "active", ...overrides })
    .returning();
  return u;
}

async function statusOf(id: string) {
  const [u] = await db.select().from(users).where(eq(users.id, id));
  return u.status;
}

test("disable mirrors onto the row; enable reverses it", async () => {
  const u = await seed("member-1");
  await setExternalUserDisabled({ externalAccountId: "member-1", disabled: true });
  assert.equal(await statusOf(u.id), "disabled");
  await setExternalUserDisabled({ externalAccountId: "member-1", disabled: false });
  assert.equal(await statusOf(u.id), "active");
});

test("no local row: both directions are a no-op, and no row is invented", async () => {
  await setExternalUserDisabled({ externalAccountId: "never-arrived", disabled: true });
  await setExternalUserDisabled({ externalAccountId: "never-arrived", disabled: false });
  assert.equal((await db.select().from(users)).length, 0);
});

test("enable never activates a row the disable path did not produce", async () => {
  // A pending row on a shared database (or any future state) must not be
  // flipped active by the integration's re-enable — only a disable is reversed.
  const u = await seed("member-2", { status: "pending" });
  await setExternalUserDisabled({ externalAccountId: "member-2", disabled: false });
  assert.equal(await statusOf(u.id), "pending");
});

test("facts: disabled flag, last activity, dataset count — batched, missing ids absent", async () => {
  const a = await seed("m-a");
  await seed("m-b", { status: "disabled" });
  await db.insert(datasets).values({ userId: a.id, name: "d1" });
  await db.insert(datasets).values({ userId: a.id, name: "d2" });
  await db.insert(history).values({ userId: a.id, toolName: "query", createdAt: new Date("2026-08-01T12:00:00Z") });
  await db.insert(history).values({ userId: a.id, toolName: "query", createdAt: new Date("2026-08-05T12:00:00Z") });

  const facts = await externalUserFacts(["m-a", "m-b", "m-ghost"]);
  const byId = new Map(facts.map((f) => [f.externalAccountId, f]));
  assert.equal(facts.length, 2, "no entry for the id with no row");

  const fa = byId.get("m-a");
  assert.ok(fa);
  assert.equal(fa.disabled, false);
  assert.equal(fa.datasetCount, 2);
  assert.equal(fa.lastActiveAt, "2026-08-05T12:00:00.000Z", "newest history row wins");

  const fb = byId.get("m-b");
  assert.ok(fb);
  assert.equal(fb.disabled, true);
  assert.equal(fb.datasetCount, 0);
  assert.equal(fb.lastActiveAt, null);
});

test("facts: empty input returns empty without touching the database", async () => {
  assert.deepEqual(await externalUserFacts([]), []);
});
