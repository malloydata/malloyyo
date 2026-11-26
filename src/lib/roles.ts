// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * Roles: what a person may DO, and which datasets they may OPEN.
 *
 * Two questions, answered in different places, and keeping them apart is the
 * whole design:
 *
 *   access — which datasets may I open?   → the roles I hold vs the roles the
 *                                            dataset lists
 *   scope  — which rows do I see inside?  → the model, from my identity
 *                                            (src/lib/tenancy.ts)
 *
 * A role can never show you more ROWS inside a dataset, and a model can never
 * let you into a dataset you were not granted. Both layers only narrow, which
 * is why "admin sees everything" must be a second dataset granted to the admin
 * role rather than an `or` inside a filter — see docs/roles-and-access.md.
 *
 * BUILT-IN roles are capabilities on this instance and are seeded, undeletable
 * and not creatable. Everything else is the operator's, named after groups of
 * people, and exists to be listed on datasets.
 */

import { and, eq, or, sql } from "drizzle-orm";
import { datasets, db, instanceSettings, users } from "@/db";
import { env } from "./env";
import type { RoleLevel } from "./role-access";

export const MALLOYYO_USER = "MALLOYYO_USER";
export const MALLOYYO_ADMIN = "MALLOYYO_ADMIN";

export const BUILTIN_ROLES = [MALLOYYO_USER, MALLOYYO_ADMIN] as const;

/**
 * Built-ins that must never be handed out by a default.
 *
 * `MALLOYYO_USER` is a fine admission default — it is the right to sign in and
 * nothing more. `MALLOYYO_ADMIN` is not, and the failure is not subtle: on an
 * `open` instance, `default_roles` is applied to every new row at first sign-in
 * (src/lib/admission.ts), so one ticked box makes anyone who signs in an
 * instance admin. A misconfiguration must fail closed; a checkbox should not be
 * able to fail this wide open.
 *
 * A list rather than a constant because the set grows the moment a second
 * capability role exists — and the one just removed, MALLOYYO_DEVELOPER, was
 * exactly such a role.
 */
export const NEVER_A_DEFAULT: readonly string[] = [MALLOYYO_ADMIN];

/** Admin because the deployment's env says so, not because a row says so — so
    no write to `users` can revoke it, and a UI that pretends otherwise lies. */
export function isEnvAdmin(email: string | null | undefined): boolean {
  return !!email && env.APP_ADMIN_EMAILS.includes(email.toLowerCase());
}

/** What a new arrival gets when the instance has not said otherwise: able to
    sign in, and holding nothing that opens a dataset. Access is then a
    deliberate grant rather than something a default handed out. */
export const DEFAULT_ROLES: readonly string[] = [MALLOYYO_USER];

export function isBuiltinRole(name: string): boolean {
  return (BUILTIN_ROLES as readonly string[]).includes(name);
}

/**
 * A role name the operator may create.
 *
 * Lowercase, because these become `$MALLOYYO_ROLES` entries a model compares
 * against — `where: department in $MALLOYYO_ROLES` reads badly if the catalog
 * is `Finance` and the column is `finance`. The `MALLOYYO_` prefix is refused
 * outright: it names capabilities this server defines, and a role that looks
 * built-in but is not would be read as authority nobody granted.
 */
const ROLE_NAME_RE = /^[a-z][a-z0-9_-]{0,38}[a-z0-9]$/;

export function roleNameError(name: string): string | null {
  if (name.startsWith("MALLOYYO_") || isBuiltinRole(name)) {
    return `'${name}': the MALLOYYO_ prefix is reserved for built-in roles.`;
  }
  if (!ROLE_NAME_RE.test(name)) {
    return `'${name}': use lowercase letters, digits, - and _, starting with a letter (2–40 characters).`;
  }
  return null;
}

/** Every role this person holds. Reads the list, and keeps honouring the older
    single-column authority so a row granted admin before roles existed does not
    quietly lose it. */
export type RoleBearing = {
  roles?: string[] | null;
  role?: string | null;
  isAdmin?: boolean | null;
  email?: string | null;
};

/**
 * Every role this person holds.
 *
 * THE one place that answers it, because the older ways of being an admin are
 * still live and any second reading of them would drift: the `role` column,
 * the `isAdmin` flag mirrored from an integration's claim, and
 * `APP_ADMIN_EMAILS`. `isAdmin()` is defined in terms of this rather than
 * beside it, so the admin badge in the UI and the checkbox on this page cannot
 * disagree about the same person.
 */
export function rolesOf(user: RoleBearing): string[] {
  const held = new Set(user.roles ?? []);
  if (user.role === "owner" || user.role === "admin" || user.isAdmin) held.add(MALLOYYO_ADMIN);
  if (isEnvAdmin(user.email)) held.add(MALLOYYO_ADMIN);
  return [...held];
}

export function hasRole(user: RoleBearing, role: string): boolean {
  return rolesOf(user).includes(role);
}

/**
 * May create datasets and publish models — admins only.
 *
 * There WAS a MALLOYYO_DEVELOPER here, for someone who should ship models
 * without administering people. It was removed because it could not mean that:
 * a dataset names a repo, that repo's model is compiled by this server, and a
 * model can define `duckdb.sql(...)` sources and a `malloy-config.json` whose
 * connection secrets are `{"env": …}` refs resolved against the server's own
 * environment. Restricted mode gates the QUERY text a caller sends, not the
 * MODEL text a repo ships. So the role would have read AUTH_SECRET and the
 * metadata database while the admin page described it as strictly lesser.
 *
 * A capability whose name understates its reach is worse than no capability.
 * The role comes back when compiling a repo's model is contained, not before.
 */
export function canAuthor(user: RoleBearing): boolean {
  return rolesOf(user).includes(MALLOYYO_ADMIN);
}

/**
 * What someone may do with a dataset they can open.
 *
 *   view   open its dashboards
 *   query  also query it: the query editor, chat, the MCP connector, saved
 *          questions, draft dashboards
 *
 * A role holds a LEVEL PER DATASET — none, dashboards (view) or full (query) —
 * which is what Admin → Roles edits. On the dataset row that is two arrays:
 * `roles` lists every role with any access, and `view_only_roles` the subset
 * that may only view. Someone's level on a dataset is the best any of their
 * roles gives them there, so one full role on it is enough to query it, and the
 * same person can query one dataset and only read dashboards on the next.
 *
 * "Dashboard-only" is therefore not a kind of account. It is what someone is
 * when every role that reaches a dataset for them is view-only there.
 *
 * A TIER, NOT A WALL. A dashboard runs restricted Malloy against its dataset,
 * so someone with view access can still read what the dataset contains. What
 * people must not see belongs in a dataset they are not granted, or behind the
 * model's row scoping. See docs/roles-and-access.md.
 */
export type DatasetAccess = "view" | "query";

// The same rule as arithmetic, for the admin page to show its working — and
// the level type both share. See src/lib/role-access.ts.
export { bestLevel, openToMembers, resolveAccess, roleLevelOn, type RoleLevel } from "./role-access";

/**
 * The roles this person holds, as a SQL array. Read from the user row in a
 * subquery rather than passed in, so every caller gets role filtering without
 * threading a list through, and a stale list can never be the thing that grants
 * access.
 */
function heldRoles(userId: string) {
  return sql`(select coalesce(${users.roles}, '{}'::text[]) from ${users} where ${users.id} = ${userId}::uuid)`;
}

/**
 * The SQL predicate for "one of this person's roles opens the dataset" — at any
 * level for `view`, at full level for `query`.
 *
 * Query level subtracts the dataset's view-only roles before testing the
 * overlap, so a role that is merely absent from `view_only_roles` is full. That
 * is the reading under which nothing changes for anyone until an admin sets a
 * role to dashboards-only on a dataset.
 */
export function datasetRoleOverlap(userId: string, need: DatasetAccess = "view") {
  if (need === "view") return sql`${datasets.roles} && ${heldRoles(userId)}`;
  return sql`array(select unnest(${datasets.roles}) except select unnest(${datasets.viewOnlyRoles})) && ${heldRoles(userId)}`;
}

/**
 * "This person is an admin", as SQL — the same answer `rolesOf()` gives, which
 * means all four ways of being one: the role list, the legacy `role` and
 * `is_admin` columns, and `APP_ADMIN_EMAILS` (which is on no row, so it is
 * bound here as a list). In SQL so that the access predicate below is whole by
 * itself: a caller holding only a user id cannot forget to say they are an
 * admin, which is exactly how most read paths came to ignore it.
 */
function isAdminSql(userId: string) {
  const envAdmins = env.APP_ADMIN_EMAILS.map((e) => e.toLowerCase());
  const byEnv =
    envAdmins.length > 0
      ? sql` or lower(${users.email}) in (${sql.join(
          envAdmins.map((e) => sql`${e}`),
          sql`, `,
        )})`
      : sql``;
  return sql`exists (select 1 from ${users} where ${users.id} = ${userId}::uuid and (${MALLOYYO_ADMIN} = any(coalesce(${users.roles}, '{}'::text[])) or ${users.role} in ('owner', 'admin') or ${users.isAdmin} = true${byEnv}))`;
}

/**
 * Which datasets this person may open (`view`) or query (`query`).
 *
 * Owning a dataset gives full access: it does not come from a role, so it
 * cannot be view-only.
 *
 * A role's level is the ONLY other grant. `datasets.is_public` used to be one
 * too: it opened a dataset in full to everyone signed in, whatever any role
 * said — so a role set to None on Admin → Roles went on opening the dataset,
 * and that page disagreed with the one listing what each person gets. It is not
 * read here or anywhere else now (0033 carried every public dataset across to
 * MALLOYYO_USER at full first, so nobody lost one). "Open to every member" is
 * `openToMembers` / `openToMembersSql`: the members role at full.
 *
 * MALLOYYO_ADMIN opens every dataset, in full. This file once argued that
 * administering an instance is not a reason to read its data, and the reversal
 * is deliberate: with per-dataset ownership gone, nothing else lets the person
 * who publishes a repo see what they just published, and nobody could grant the
 * first role on a dataset nobody can see. It is decided in the predicate itself
 * (`isAdminSql`) rather than by a flag the caller passes, because a flag most
 * callers did not pass is how the dashboards, the query paths and the MCP tools
 * all went on refusing admins while the source list showed them everything.
 */
export function datasetAccessWhere(userId: string, need: DatasetAccess) {
  return and(
    or(
      eq(datasets.userId, userId),
      datasetRoleOverlap(userId, need),
      isAdminSql(userId),
    ),
    eq(datasets.status, "ready"),
  );
}

/**
 * The column values that put ONE role at ONE level on a dataset, for a
 * `db.update(datasets).set(...)`.
 *
 * Both arrays move in one statement, built from the row as it is when the
 * statement runs, so two admins setting two roles on the same dataset cannot
 * write over each other, and no reader ever sees a role half-moved (listed as
 * view-only but not listed at all).
 */
export function roleLevelUpdate(name: string, level: RoleLevel) {
  type RoleArray = typeof datasets.roles | typeof datasets.viewOnlyRoles;
  const without = (col: RoleArray) => sql`array_remove(${col}, ${name})`;
  const withIt = (col: RoleArray) =>
    sql`case when ${name} = any(${col}) then ${col} else array_append(${col}, ${name}) end`;
  return {
    roles: level === "none" ? without(datasets.roles) : withIt(datasets.roles),
    viewOnlyRoles: level === "view" ? withIt(datasets.viewOnlyRoles) : without(datasets.viewOnlyRoles),
  };
}

/**
 * `openToMembers` (src/lib/role-access.ts) as a SQL predicate on the datasets
 * row: every member can query this. What replaced `is_public = true` wherever
 * that was a WHERE clause — what a signed-out visitor is told exists, whose
 * question history someone who did not ask may read.
 */
export function openToMembersSql() {
  return sql`(${MALLOYYO_USER} = any(${datasets.roles}) and not (${MALLOYYO_USER} = any(${datasets.viewOnlyRoles})))`;
}

/** Datasets this person may OPEN. The name every read path already uses. */
export function datasetVisibleWhere(userId: string) {
  return datasetAccessWhere(userId, "view");
}

/**
 * The roles a newly admitted person gets.
 *
 * `instance_settings.default_roles` when an admin has set it, else
 * DEFAULT_ROLES. Deliberately a read per admission rather than a cached value:
 * admissions are rare, and a default that lags an admin's change is the kind of
 * thing nobody would think to look for.
 */
export async function defaultRoles(): Promise<string[]> {
  const [row] = await db
    .select({ defaultRoles: instanceSettings.defaultRoles })
    .from(instanceSettings)
    .where(eq(instanceSettings.instanceCode, env.INSTANCE_CODE))
    .limit(1);
  const configured = row?.defaultRoles ?? null;
  return configured && configured.length > 0 ? configured : [...DEFAULT_ROLES];
}
