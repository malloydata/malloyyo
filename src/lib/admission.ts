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
import { logger } from "./logger";

/**
 * Decide the new user's status and role.
 *
 * - Bootstrap: the first sign-in on an instance with no owner and no other
 *   active user becomes `owner` + `active`. No env var, no chicken-and-egg —
 *   a fresh clone's first sign-in just works.
 * - An open invitation for the address admits immediately (and is consumed,
 *   carrying its role).
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
      .set({ status: "active", role: "owner", isAdmin: true })
      .where(eq(users.id, userId));
    logger.info("first sign-in became the instance owner", { userId });
    return;
  }

  const address = email?.trim().toLowerCase();
  if (address) {
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
      .set({ status: "active" })
      .where(and(eq(users.id, userId), ne(users.status, "disabled")));
    return;
  }
  // `invite` with no invitation: the schema default already says `pending`;
  // leave the row for the approval queue.
  logger.info("new user awaiting approval", { userId });
}
