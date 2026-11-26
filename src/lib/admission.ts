// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// What happens to a NEW row the moment the application's own sign-in creates it.
// Called from the createUser event in src/auth.ts, which Auth.js awaits before
// the session exists — so by the first authorized request the decision is made.
// The schema default is `pending`, so a path that skips this fails closed.
//
// Deciding here rather than refusing at sign-in is deliberate: authentication
// always succeeds, and what the person may DO is answered per-request by
// src/lib/authorize.ts. A newcomer under `invite` gets a row that says
// `pending`, not an opaque OAuth error.

import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { db, invitations, users } from "@/db";
import { getAccessPolicy } from "./access-policy";
import { defaultRoles, MALLOYYO_ADMIN, MALLOYYO_USER } from "./roles";
import { logger } from "./logger";

function admittedRoles(roles: readonly string[], admin: boolean): string[] {
  return admin ? [...new Set([...roles, MALLOYYO_ADMIN])] : [...roles];
}

/**
 * Decide the new user's status and role.
 *
 * - Bootstrap: the first sign-in on an instance with no owner and no other
 *   active user becomes `owner` + `active`. No env var, no chicken-and-egg —
 *   a fresh clone's first sign-in just works.
 * - Someone an admin ADDED never reaches this function: their first sign-in
 *   claims the row that was made for them (src/lib/claim.ts), which is already
 *   decided. This decides about rows nobody has decided about.
 * - An open invitation for the address admits immediately (and is consumed,
 *   carrying its role) — a leftover; see below.
 * - Otherwise the instance's access policy decides: `open` admits as an
 *   ordinary member; `invite` leaves the row `pending` for the approval queue.
 */
export async function admitNewUser(userId: string, email: string | null | undefined): Promise<void> {
  // Bootstrap check: no owner anywhere, and no OTHER active row. The "other
  // active" guard is what keeps this from ever firing on an established
  // instance — e.g. one migrated from the allow-list era whose admins came from
  // APP_ADMIN_EMAILS and so seeded no owner. Handing ownership to whoever signs
  // in next there would be a takeover, not a bootstrap.
  const [existing] = await db
    .select({
      owners: sql<number>`count(*) filter (where ${users.role} = 'owner')`,
      otherActive: sql<number>`count(*) filter (where ${users.status} = 'active' and ${users.id} <> ${userId})`,
    })
    .from(users);
  if (Number(existing.owners) === 0 && Number(existing.otherActive) === 0) {
    await db
      .update(users)
      .set({ status: "active", role: "owner", isAdmin: true, roles: [MALLOYYO_USER, MALLOYYO_ADMIN] })
      .where(eq(users.id, userId));
    logger.info("first sign-in became the instance owner", { userId });
    return;
  }

  const address = email?.trim().toLowerCase();
  if (address) {
    // A STRAGGLER'S PATH. Nothing creates invitations any more: Add user
    // creates the person (src/lib/roster.ts), and the migration that brought
    // that in turned every open invitation into one. This is for an invitation
    // made by the PREVIOUS version in the minutes between that migration and
    // this code going live. It can go when the `invitations` table does.
    //
    // Consume an open invitation atomically; the returning row tells us it was
    // ours to consume, so two racing sign-ins can't both ride one invitation.
    const [invitation] = await db
      .update(invitations)
      .set({ acceptedAt: new Date(), acceptedById: userId })
      .where(and(eq(invitations.email, address), isNull(invitations.acceptedAt)))
      .returning();
    if (invitation) {
      await db
        .update(users)
        .set({
          status: "active",
          // An invitation may carry admin; it never mints an owner.
          role: invitation.role === "owner" ? "admin" : invitation.role,
          isAdmin: invitation.role !== "member",
          // An invitation carrying admin grants the admin role too; everyone
          // else starts on the instance default (src/lib/roles.ts).
          roles: admittedRoles(await defaultRoles(), invitation.role !== "member"),
        })
        .where(and(eq(users.id, userId), ne(users.status, "disabled")));
      logger.info("invitation consumed on first sign-in", { userId });
      return;
    }
  }

  const policy = await getAccessPolicy();
  if (policy === "open") {
    await db
      .update(users)
      .set({ status: "active", roles: await defaultRoles() })
      .where(and(eq(users.id, userId), ne(users.status, "disabled")));
    return;
  }
  // `invite` with no invitation: the schema default already says `pending`;
  // leave the row for the approval queue. Roles are granted on approval, not
  // here — someone waiting to be let in holds nothing.
  logger.info("new user awaiting approval", { userId });
}
