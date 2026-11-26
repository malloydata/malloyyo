// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The one-time seeding from EMAIL_ALLOW_LIST to database membership. The
// SCHEMA half (users.status/role, invitations, instance_settings.access_policy)
// is an ordinary journal entry the boot migrator applies; this is the DATA
// half, which no journal entry can carry because the list is a per-instance
// environment value. Called from runMigrations() after the journal applies,
// under the same advisory lock — which covers every path that migrates: boots
// with migrations enabled, and hand-run `npx tsx scripts/run-boot-migrations.ts`
// (both load the instance's environment, where the list lives).
//
// Seeding runs once per database, not once per boot. The guard is data, not a
// flag: seed only while the users table is non-empty, no access policy has
// been recorded, and EVERY row still carries the fail-closed default status —
// i.e. the columns exist but nothing has decided anything yet. The moment
// seeding (or anyone's first sign-in, or an admin) sets one row, the guard is
// closed forever. Fresh installs never trip it: their first sign-in becomes
// the active owner before any seeding could run, per src/lib/admission.ts.
//
// The rules are behavior-preserving on upgrade, and each is a requirement
// (docs in the private design record; summarized here):
//
// - Addresses on the list with no users row become OPEN INVITATIONS — a row
//   exists only once someone signs in, and dropping the not-yet-arrived would
//   silently revoke people the operator had admitted.
// - Every existing row NOT on the list lands `disabled`. Those people are
//   refused on every request today; marking them active would grant access to
//   exactly the population the list was excluding — silently, and to the
//   people most likely to have been removed on purpose.
// - With no list set, every existing row lands `active` and the policy is
//   recorded as `open` — the state the instance was already in, made visible.

import type { Sql } from "postgres";
import { logger } from "./logger";

export function parseAllowList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Seed membership once. `sql` must be an open connection with search_path
 * pinned to public and the schema already migrated (runMigrations does both,
 * and holds the advisory lock across this call).
 */
export async function seedAccessControl(
  sql: Sql,
  opts: { allowList: string | undefined; instanceCode: string },
): Promise<void> {
  await sql.begin(async (tx) => {
    // Guard evaluated inside the transaction so two racing callers can't both
    // seed. `FOR UPDATE` on the policy row is unavailable (it may not exist);
    // the all-pending check is the effective lock — the first committer flips it.
    const [{ total, decided }] = await tx<[{ total: string; decided: string }]>`
      SELECT count(*)::text AS total,
             count(*) FILTER (WHERE status <> 'pending')::text AS decided
      FROM users`;
    if (Number(total) === 0 || Number(decided) > 0) return;

    const [policyRow] = await tx<[{ access_policy: string | null }?]>`
      SELECT access_policy FROM instance_settings
      WHERE instance_code = ${opts.instanceCode}`;
    if (policyRow?.access_policy) return;

    const list = parseAllowList(opts.allowList);
    const listCsv = list.join(",");

    if (list.length > 0) {
      await tx`
        UPDATE users SET status = 'active'
        WHERE lower(email) = ANY (string_to_array(${listCsv}, ','))`;
      await tx`
        UPDATE users SET status = 'disabled'
        WHERE email IS NULL OR NOT (lower(email) = ANY (string_to_array(${listCsv}, ',')))`;
      await tx`
        INSERT INTO invitations (email)
        SELECT t.e FROM unnest(string_to_array(${listCsv}, ',')) AS t(e)
        WHERE NOT EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = t.e)
          AND NOT EXISTS (SELECT 1 FROM invitations i WHERE i.email = t.e AND i.accepted_at IS NULL)`;
    } else {
      await tx`UPDATE users SET status = 'active'`;
    }

    // Roles: the admin column carries over; the earliest active admin becomes
    // the owner (there is no better record of who provisioned the instance).
    await tx`UPDATE users SET role = 'admin' WHERE is_admin AND role = 'member'`;
    await tx`
      UPDATE users SET role = 'owner'
      WHERE id = (SELECT id FROM users WHERE is_admin AND status = 'active'
                  ORDER BY created_at, id LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'owner')`;

    const policy = list.length > 0 ? "invite" : "open";
    await tx`
      INSERT INTO instance_settings (instance_code, access_policy)
      VALUES (${opts.instanceCode}, ${policy})
      ON CONFLICT (instance_code)
      DO UPDATE SET access_policy = EXCLUDED.access_policy, updated_at = now()`;

    logger.info("access-control seeding complete", {
      policy,
      users: Number(total),
      invited: list.length,
    });
  });

  // Not inside the transaction: a warning, not a rule. Skipped while the users
  // table is empty — a fresh install's first sign-in will mint its owner.
  const [{ total, admins }] = await sql<[{ total: string; admins: string }]>`
    SELECT count(*)::text AS total,
           count(*) FILTER (WHERE status = 'active' AND (is_admin OR role IN ('owner', 'admin')))::text AS admins
    FROM users`;
  if (Number(total) > 0 && Number(admins) === 0) {
    logger.warn(
      "no active admin exists — administration relies on APP_ADMIN_EMAILS or BREAK_GLASS_EMAIL until one is promoted",
    );
  }
}
