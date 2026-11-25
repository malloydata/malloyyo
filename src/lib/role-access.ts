// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * What a set of roles adds up to, dataset by dataset — as plain arithmetic.
 *
 * The rule itself is enforced in SQL (`datasetAccessWhere`, src/lib/roles.ts).
 * This is the same rule written out for the ADMIN PAGE, which has to show its
 * working: "what does this person get, and which role is why", and "what would
 * they get if I ticked this one". No database and no server imports, so the
 * browser runs it on every tick of a checkbox.
 *
 * The two must agree, and test/dashboard-audience.test.ts holds them to it.
 */

/** What one role — or, combined, one person — has on one dataset. */
export type RoleLevel = "none" | "view" | "query";

export const LEVEL_LABEL: Record<RoleLevel, string> = {
  none: "None",
  view: "Dashboards",
  query: "Full",
};

const RANK: Record<RoleLevel, number> = { none: 0, view: 1, query: 2 };

/** The built-in admin role, by name — repeated here because this file cannot
    import the server module that defines it. */
const ADMIN_ROLE = "MALLOYYO_ADMIN";

/** The slice of a dataset row that decides access. */
export interface DatasetGrants {
  id: string;
  /** Every role with any access. */
  roles?: readonly string[] | null;
  /** The subset of `roles` that may only view. */
  viewOnlyRoles?: readonly string[] | null;
  /** The legacy public flag: full access for everyone signed in. */
  isPublic?: boolean | null;
  /** Its owner, who has full access whatever roles they hold. */
  ownerId?: string | null;
}

/** Read one role's level off the two arrays. The one place that says what they
    mean together. */
export function roleLevelOn(ds: Pick<DatasetGrants, "roles" | "viewOnlyRoles">, role: string): RoleLevel {
  if (!(ds.roles ?? []).includes(role)) return "none";
  return (ds.viewOnlyRoles ?? []).includes(role) ? "view" : "query";
}

/** The best of several levels — how the roles one person holds combine. */
export function bestLevel(levels: readonly RoleLevel[]): RoleLevel {
  return levels.reduce<RoleLevel>((best, l) => (RANK[l] > RANK[best] ? l : best), "none");
}

export interface ResolvedAccess {
  datasetId: string;
  level: RoleLevel;
  /** What gives them that level: role names, or a reason that is not a role
      ("owner", "public dataset"). Empty when the level is none. */
  because: string[];
}

/**
 * What someone holding `held` gets on each dataset, and why.
 *
 * The higher level wins when two roles name the same dataset, and `because`
 * lists every role that gives the winning level — so the page can say "Full,
 * from analysts" and not just "Full".
 */
export function resolveAccess(
  held: readonly string[],
  datasets: readonly DatasetGrants[],
  who: { userId?: string } = {},
): ResolvedAccess[] {
  const admin = held.includes(ADMIN_ROLE);
  return datasets.map((ds) => {
    if (admin) return { datasetId: ds.id, level: "query", because: [ADMIN_ROLE] };
    const reasons: { level: RoleLevel; why: string }[] = held.map((role) => ({
      level: roleLevelOn(ds, role),
      why: role,
    }));
    if (ds.isPublic) reasons.push({ level: "query", why: "public dataset" });
    if (who.userId && ds.ownerId === who.userId) reasons.push({ level: "query", why: "owner" });
    const level = bestLevel(reasons.map((r) => r.level));
    return {
      datasetId: ds.id,
      level,
      because: level === "none" ? [] : reasons.filter((r) => r.level === level).map((r) => r.why),
    };
  });
}
