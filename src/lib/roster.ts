// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Admin actions on the roster: approve/deny the queue, disable/enable members,
// grant and revoke admin, and standing invitations for addresses that have not
// arrived. The rules live here rather than in the routes so they are one thing
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

import { and, eq, isNull } from "drizzle-orm";
import { db, invitations, users, type Invitation, type User, type UserRole } from "@/db";
import { defaultRoles, MALLOYYO_ADMIN } from "./roles";
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

export type InviteOutcome =
  | { kind: "invited"; invitation: Invitation }
  | { kind: "approved"; user: User };

/**
 * Admit an address ahead of arrival. If the person already arrived and is
 * waiting in the queue, inviting them IS approving them (with the invited
 * role); re-inviting an already-open address just updates its role.
 */
export async function createInvitation(actor: User, rawEmail: string, role: UserRole): Promise<InviteOutcome> {
  const email = rawEmail.trim().toLowerCase();
  // Deliberately loose: providers own address validity. This only rejects
  // things that cannot be an address at all.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new RosterError("not an email address");
  if (role !== "member" && role !== "admin") throw new RosterError("role must be member or admin");

  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing) {
    switch (existing.status) {
      case "pending": {
        // Roles too, and for the same reason `applyUserAction('approve')` does
        // it: admission is where the instance default lands. Setting only the
        // legacy columns left the row with `roles = '{}'`, which the SQL access
        // predicate reads as holding nothing while the admin page listed them as
        // holding the default — a grant the UI asserted and every query denied.
        const granted =
          (existing.roles ?? []).length > 0 ? existing.roles! : await defaultRoles();
        const [approved] = await db
          .update(users)
          .set({
            status: "active",
            role: existing.role === "owner" ? existing.role : role,
            isAdmin: role === "admin",
            roles:
              role === "admin" ? [...new Set([...granted, MALLOYYO_ADMIN])] : granted,
          })
          .where(eq(users.id, existing.id))
          .returning();
        logger.info("invitation approved a waiting user", { userId: existing.id, actorId: actor.id });
        return { kind: "approved", user: approved };
      }
      case "active":
        throw new RosterError("already an active user");
      case "disabled":
        throw new RosterError("this address belongs to a disabled user — enable them instead");
    }
  }

  const [open] = await db
    .select()
    .from(invitations)
    .where(and(eq(invitations.email, email), isNull(invitations.acceptedAt)))
    .limit(1);
  if (open) {
    if (open.role === role) return { kind: "invited", invitation: open };
    const [updated] = await db
      .update(invitations)
      .set({ role })
      .where(eq(invitations.id, open.id))
      .returning();
    return { kind: "invited", invitation: updated };
  }

  const [created] = await db
    .insert(invitations)
    .values({ email, role, invitedById: actor.id })
    .returning();
  logger.info("invitation created", { email, role, actorId: actor.id });
  return { kind: "invited", invitation: created };
}

/** Withdraw a standing invitation. Accepted ones are history and stay. */
export async function revokeInvitation(actor: User, id: string): Promise<void> {
  const deleted = await db
    .delete(invitations)
    .where(and(eq(invitations.id, id), isNull(invitations.acceptedAt)))
    .returning();
  if (deleted.length === 0) throw new RosterError("no such open invitation", 404);
  logger.info("invitation revoked", { invitationId: id, actorId: actor.id });
}
