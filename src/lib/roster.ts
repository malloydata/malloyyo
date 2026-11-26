// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Admin actions on the roster: approve/deny the queue, disable/enable members,
// grant and revoke admin, and adding people ahead of their first sign-in. The rules live here rather than in the routes so they are one thing
// to test and the routes stay thin.
//
// Guardrails, all server-side:
// - An owner is untouchable through this surface. Changing an owner is an
//   owner-to-owner concern this instance does not offer yet, and the safe
//   failure is refusal, not a demoted owner.
// - You cannot revoke your own access (disable/deny/demote yourself). The
//   instance must always keep the admin who is acting; locking yourself out is
//   a support ticket, not a feature.
// - Transitions are checked against the CURRENT row, so a stale page cannot
//   e.g. re-approve someone an admin just disabled.

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, roles as rolesTable, users, type User } from "@/db";
import { defaultRoles, isBuiltinRole, MALLOYYO_ADMIN } from "./roles";
import { logger } from "./logger";

export class RosterError extends Error {
  status: number;
  constructor(msg: string, status = 400) {
    super(msg);
    this.name = "RosterError";
    this.status = status;
  }
}

export const USER_ACTIONS = ["approve", "deny", "disable", "enable", "promote", "demote"] as const;
export type UserAction = (typeof USER_ACTIONS)[number];

export async function applyUserAction(actor: User, targetId: string, action: UserAction): Promise<User> {
  const [target] = await db.select().from(users).where(eq(users.id, targetId)).limit(1);
  if (!target) throw new RosterError("no such user", 404);

  if (target.role === "owner") {
    throw new RosterError("the owner's access and role cannot be changed here");
  }
  if (target.id === actor.id && (action === "disable" || action === "deny" || action === "demote")) {
    throw new RosterError("you cannot revoke your own access or role");
  }

  const set: Partial<Pick<User, "status" | "role" | "isAdmin" | "roles">> = {};
  switch (action) {
    case "approve":
      if (target.status !== "pending") throw new RosterError("only a pending user can be approved");
      set.status = "active";
      // Approval is the moment someone becomes a member, so it is where the
      // instance default lands. A UNION rather than "only if they hold nothing":
      // an upgraded instance's backfill gave every pre-existing row
      // `MALLOYYO_USER`, including rows still in the queue, so a cardinality test
      // would see "already has roles" and admit them with no dataset-bearing role
      // — silently, and only on the instances hardest to notice it on.
      set.roles = [...new Set([...(target.roles ?? []), ...(await defaultRoles())])];
      break;
    case "deny":
      if (target.status !== "pending") throw new RosterError("only a pending user can be denied");
      set.status = "disabled";
      break;
    case "disable":
      if (target.status !== "active") throw new RosterError("only an active user can be disabled");
      set.status = "disabled";
      break;
    case "enable":
      if (target.status !== "disabled") throw new RosterError("only a disabled user can be enabled");
      set.status = "active";
      break;
    case "promote":
      if (target.role !== "member") throw new RosterError("already an admin");
      set.role = "admin";
      set.isAdmin = true;
      set.roles = [...new Set([...(target.roles ?? []), MALLOYYO_ADMIN])];
      break;
    case "demote":
      if (target.role !== "admin") throw new RosterError("not an admin");
      set.role = "member";
      set.isAdmin = false;
      // Only the capability goes. Dataset-bearing roles are a separate grant and
      // demoting someone from admin is not a decision about what data they read.
      set.roles = (target.roles ?? []).filter((r) => r !== MALLOYYO_ADMIN);
      break;
  }

  const [updated] = await db.update(users).set(set).where(eq(users.id, target.id)).returning();
  logger.info("roster action", { action, targetId: target.id, actorId: actor.id });
  return updated;
}

export type AddOutcome =
  | { kind: "added"; user: User }
  | { kind: "approved"; user: User };

/**
 * Add a person: an address, and the roles they start with.
 *
 * It creates the USER — active, holding exactly `roles`, not yet signed in
 * (`first_signed_in_at` NULL). From that moment they are a row like anyone
 * else: their roles can be edited, a dashboard can be shared with them, and an
 * admin can impersonate them to see what they will see. Their first sign-in
 * with that address claims the row (src/lib/claim.ts).
 *
 * This replaces the invitation, which was an address and "member" or "admin"
 * in a table of its own: a second record of a person, a second place a role
 * name could be left behind, and nothing an admin could do anything with until
 * the person arrived.
 *
 * If the address is already waiting in the queue, adding them IS approving
 * them, with the roles just ticked — those were chosen for this person, a
 * moment ago, by someone looking at what they add up to.
 *
 * MALLOYYO_ADMIN in `roles` and the two legacy admin columns are one fact, and
 * are written together, as everywhere else roles are written.
 */
export async function addUser(actor: User, rawEmail: string, roles: readonly string[]): Promise<AddOutcome> {
  const email = rawEmail.trim().toLowerCase();
  // Deliberately loose: providers own address validity. This only rejects
  // things that cannot be an address at all.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new RosterError("not an email address");

  const wanted = [...new Set(roles)];
  if (wanted.length > 0) {
    // Only names from the catalog, as everywhere else roles are written: a
    // typo here would be a role on a person that no checkbox can show.
    const known = await db.select({ name: rolesTable.name }).from(rolesTable).where(inArray(rolesTable.name, wanted));
    const unknown = wanted.filter((r) => !isBuiltinRole(r) && !known.some((k) => k.name === r));
    if (unknown.length) throw new RosterError(`unknown role(s): ${unknown.join(", ")}`);
  }
  const admin = wanted.includes(MALLOYYO_ADMIN);
  const legacy = admin ? { role: "admin" as const, isAdmin: true } : { role: "member" as const, isAdmin: false };

  const [existing] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);
  if (existing) {
    switch (existing.status) {
      case "pending": {
        const [approved] = await db
          .update(users)
          .set({ status: "active", roles: wanted, ...(existing.role === "owner" ? {} : legacy) })
          .where(eq(users.id, existing.id))
          .returning();
        logger.info("adding a waiting user approved them", { userId: existing.id, actorId: actor.id });
        return { kind: "approved", user: approved };
      }
      case "active":
        throw new RosterError(
          existing.firstSignedInAt === null
            ? "already added — change their roles in the list, or remove them and add them again"
            : "already an active user",
        );
      case "disabled":
        throw new RosterError("this address belongs to a disabled user — enable them instead");
    }
  }

  const [created] = await db
    .insert(users)
    .values({ email, status: "active", roles: wanted, ...legacy, firstSignedInAt: null, addedById: actor.id })
    .returning();
  logger.info("user added", { userId: created.id, roles: wanted, actorId: actor.id });
  return { kind: "added", user: created };
}

/**
 * Take back someone who was added and has not signed in yet.
 *
 * Only that: once a person has signed in they have history, drafts and chats
 * hanging off the row, and the way to end their access is Disable, which keeps
 * all of it. Before then there is nothing of theirs to keep — only what admins
 * attached (roles, dashboard shares), which goes with the row.
 */
export async function removeAddedUser(actor: User, userId: string): Promise<void> {
  const removed = await db
    .delete(users)
    .where(and(eq(users.id, userId), isNull(users.firstSignedInAt), isNull(users.externalAccountId)))
    .returning({ id: users.id });
  if (removed.length === 0) {
    throw new RosterError("no such added user — someone who has signed in is disabled, not removed", 404);
  }
  logger.info("added user removed", { userId, actorId: actor.id });
}
