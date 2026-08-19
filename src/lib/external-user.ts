// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The local `users` row for somebody an external identity provider authenticated.
//
// This is the one database capability the application lends an authentication integration
// (src/lib/hosted-auth.ts). It is deliberately a function rather than a handle on the
// database: an integration gets exactly this and cannot read or write anything else, and
// it never sees the schema.

import { and, eq, inArray, max, sql } from "drizzle-orm";
import { db, datasets, history, users } from "@/db";
import { logger } from "@/lib/logger";

/** Did this write fail because another row already holds the address? */
function isEmailTaken(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /users_email_unique/i.test(msg);
}

/**
 * The local `users` row for a verified sign-in, created on first arrival.
 *
 * Keyed on `external_account_id` — the provider's stable subject identifier (whatever the provider
 * calls its subject) — never on email: a session JWT reveals an address only sometimes, and
 * the subject stays right if the person later changes theirs. Admin-ness is reconciled on
 * every sign-in from the provider's own role, so a role granted or revoked upstream takes
 * effect at the next session renewal rather than needing a database edit.
 */
export async function findOrCreateExternalUser(input: {
  externalAccountId: string;
  email: string | null;
  isAdmin: boolean;
}) {
  const { externalAccountId, email, isAdmin } = input;
  // The provider's role claim, mirrored into both columns — `role` for the
  // application's vocabulary, `isAdmin` for the queries that predate it. Never
  // `owner`: ownership is an application concept, and the provider's own
  // administration covers what owner means on such a deployment.
  const role = isAdmin ? ("admin" as const) : ("member" as const);
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.externalAccountId, externalAccountId))
    .limit(1);

  if (existing) {
    // Deliberately never touches `status`: the provider re-admitting someone
    // must not resurrect a row the instance disabled — the local mirror is the
    // instance's own say (revocation that outruns token expiry), and only an
    // explicit local action clears it.
    if (existing.isAdmin === isAdmin && existing.role === role && (email === null || existing.email === email)) {
      return existing;
    }
    try {
      const [updated] = await db
        .update(users)
        .set({ isAdmin, role, ...(email === null ? {} : { email }) })
        .where(eq(users.id, existing.id))
        .returning();
      return updated;
    } catch (err) {
      if (!isEmailTaken(err)) throw err;
      // Another row holds this address. Reconcile the role anyway and leave the address
      // alone — refusing a legitimately signed-in member over a display field would lock
      // them out of the instance entirely.
      logger.warn("externally-authenticated user's new email is already claimed; keeping the old one", {
        externalAccountId,
      });
      const [updated] = await db
        .update(users)
        .set({ isAdmin, role })
        .where(eq(users.id, existing.id))
        .returning();
      return updated;
    }
  }

  // Created `active`: existence of a verified sign-in from the provider IS the
  // admission decision on such a deployment — there is no approval queue the
  // provider's admin cannot see.
  const row = { externalAccountId, email, isAdmin, role, status: "active" as const };
  try {
    const [created] = await db.insert(users).values(row).returning();
    return created;
  } catch (err) {
    if (!isEmailTaken(err)) throw err;
    // A different row already holds this address — two identities claiming one email.
    // Admitting without the address is right: the authorization decision (a valid session
    // for *this* Organization) is already sound, and taking over somebody else's row on
    // the strength of an address the provider may not have verified would be an account
    // takeover. Losing a display email is the small harm.
    logger.warn("externally-authenticated user's email is already claimed; creating without it", {
      externalAccountId,
    });
    const [created] = await db
      .insert(users)
      .values({ ...row, email: null })
      .returning();
    return created;
  }
}

/**
 * Mirror a revocation made in the integration's own membership surface onto the
 * local row — the instance's own say, effective on the very next request
 * (src/lib/authorize.ts reads the row per request), instead of at session
 * expiry. Lent to the integration as `setUserDisabled`.
 *
 * No local row means the person never signed in here: nothing to mirror, and
 * minting a row for them would invent an arrival that never happened. Re-enable
 * only reverses a disable — a row in any other state is left alone, so this can
 * never resurrect or activate anyone the application itself refused.
 */
export async function setExternalUserDisabled(input: {
  externalAccountId: string;
  disabled: boolean;
}): Promise<void> {
  const { externalAccountId, disabled } = input;
  const updated = await db
    .update(users)
    .set({ status: disabled ? "disabled" : "active" })
    .where(
      disabled
        ? eq(users.externalAccountId, externalAccountId)
        : and(eq(users.externalAccountId, externalAccountId), eq(users.status, "disabled")),
    )
    .returning({ id: users.id });
  logger.info("external membership surface toggled local disable", {
    externalAccountId,
    disabled,
    mirrored: updated.length > 0,
  });
}

/**
 * The application's read-only facts about externally-keyed people, batched for
 * the integration's roster. Lent as `getUserFacts`. People with no local row
 * have no entry — they have not arrived, so there are no facts to report.
 */
export async function externalUserFacts(externalAccountIds: string[]): Promise<
  Array<{
    externalAccountId: string;
    disabled: boolean;
    lastActiveAt: string | null;
    datasetCount: number;
  }>
> {
  const ids = externalAccountIds.filter(Boolean);
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      externalAccountId: users.externalAccountId,
      status: users.status,
      lastActiveAt: max(history.createdAt),
      datasetCount: sql<number>`count(distinct ${datasets.id})::int`,
    })
    .from(users)
    .leftJoin(history, eq(history.userId, users.id))
    .leftJoin(datasets, eq(datasets.userId, users.id))
    .where(inArray(users.externalAccountId, ids))
    .groupBy(users.id);
  return rows.map((r) => ({
    externalAccountId: r.externalAccountId as string,
    disabled: r.status === "disabled",
    // An aggregate's driver value can be a Date or a raw string depending on the
    // mapping path; normalize rather than assume.
    lastActiveAt: r.lastActiveAt == null ? null : new Date(r.lastActiveAt).toISOString(),
    datasetCount: Number(r.datasetCount ?? 0),
  }));
}
