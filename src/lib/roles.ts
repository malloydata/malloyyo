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

export const MALLOYYO_USER = "MALLOYYO_USER";
export const MALLOYYO_ADMIN = "MALLOYYO_ADMIN";

/**
 * Dashboards only — the one built-in that takes something AWAY.
 *
 * Everything else here grants: hold a role, gain what it opens. This one
 * narrows what its holder may do to opening dashboards, and it is shaped that
 * way on purpose. The alternative — a positive "may query" capability, with
 * dashboard-only meaning its absence — cannot be deployed: people admitted
 * through a hosted sign-in hold no built-in role at all (src/lib/external-user.ts
 * writes none), so absence would have described every one of them at once.
 *
 * Being a restriction also makes it safe as an admission default, where
 * MALLOYYO_ADMIN is not: an instance whose arrivals should all be
 * dashboard-only just lists it there.
 *
 * It says nothing about WHICH dashboards. That is the datasets their other
 * roles open, minus the private dashboards nobody shared with them
 * (src/lib/dashboards/audience.ts).
 */
export const MALLOYYO_DASHBOARD_ONLY = "MALLOYYO_DASHBOARD_ONLY";

export const BUILTIN_ROLES = [MALLOYYO_USER, MALLOYYO_ADMIN, MALLOYYO_DASHBOARD_ONLY] as const;

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
 * May use the surfaces that QUERY: the query editor, chat, the MCP connector,
 * the CLI and API tokens, saved questions, draft dashboards.
 *
 * Everyone, unless they hold MALLOYYO_DASHBOARD_ONLY — and an admin regardless,
 * because someone who can publish a model and grant roles is not meaningfully
 * kept out of a query box, and an instance must never be able to tick its way
 * into having an admin who cannot use it.
 *
 * This is a product tier, not a wall around data. A dashboard runs restricted
 * Malloy against its dataset, so a dashboard-only person can still read
 * whatever the datasets they can open contain. What they see is governed where
 * it always was: by which datasets their roles open, and by the model's own
 * row scoping.
 */
export function canExplore(user: RoleBearing): boolean {
  const held = rolesOf(user);
  return held.includes(MALLOYYO_ADMIN) || !held.includes(MALLOYYO_DASHBOARD_ONLY);
}

/** What a refused surface says. One sentence, used by every gate, so the API,
    the CLI and the MCP client all explain the same thing the same way. */
export const DASHBOARD_ONLY_MESSAGE =
  "this account is dashboard-only: it can open dashboards, and cannot use the query editor, chat, " +
  "the MCP connector, the CLI or API tokens. Ask an admin of this instance if that is wrong.";

/**
 * The SQL predicate for "datasets this person may open".
 *
 * Owner, or public, or one of their roles is listed on the dataset. The roles
 * come from a subquery on the user row rather than from an argument, so every
 * caller of `visibleDatasetWhere` gets role filtering without threading a list
 * through — and so a stale list can never be the thing that grants access.
 *
 * Note what is NOT here: being an admin. Running a query returns ROWS, and
 * administering an instance has never been a reason to read its data. An admin
 * who needs a dataset is granted a role on it like anyone else.
 */
export function datasetRoleOverlap(userId: string) {
  return sql`${datasets.roles} && (select coalesce(${users.roles}, '{}'::text[]) from ${users} where ${users.id} = ${userId}::uuid)`;
}

/**
 * Which datasets this person may read.
 *
 * `isAdmin` is passed rather than derived in SQL, and that is deliberate: the
 * canonical answer folds in the legacy `role`/`is_admin` columns and
 * `APP_ADMIN_EMAILS` (see `rolesOf`), so a query that only checked
 * `users.roles` would miss an admin whose authority comes from the env var and
 * silently show them nothing.
 *
 * MALLOYYO_ADMIN opens every dataset. This reverses what this file used to argue
 * — that administering an instance is not a reason to read its data — and the
 * reversal is deliberate: with per-dataset ownership gone, nothing else lets the
 * person who publishes a repo see what they just published, and nobody could
 * grant the first role on a dataset nobody can see.
 */
export function datasetVisibleWhere(userId: string, isAdmin = false) {
  const reach = isAdmin
    ? sql`true`
    : or(eq(datasets.userId, userId), eq(datasets.isPublic, true), datasetRoleOverlap(userId));
  return and(reach, eq(datasets.status, "ready"));
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
