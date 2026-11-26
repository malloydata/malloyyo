// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * Changing who sees a dashboard — the write side of ./audience.
 *
 * The same two levers for every dashboard, which is the point — a draft and
 * the published dashboard it becomes behave identically:
 *
 *   general access   `private` (only the people listed) or `dataset`
 *                    (everyone who can open the dataset)
 *   people           email addresses it is shared with
 *
 * What differs is only who may pull them: a draft's author or an admin for a
 * draft, an admin for a published dashboard.
 *
 * Nothing here opens a dataset. A person a dashboard is shared with still has
 * to be able to open the dataset it is built on, and sharing with someone who
 * cannot says so rather than appearing to work — see `shareDashboard`.
 *
 * DB-only: no Malloy, no DuckDB, so a page may import it.
 */

import { and, asc, eq, sql } from "drizzle-orm";
import { dashboardGrants, datasets, db, draftDashboards, users, type DraftVisibility, type User } from "@/db";
import { hasRole, MALLOYYO_ADMIN, rolesOf } from "@/lib/roles";
import { resolveAccess, type DatasetGrants } from "@/lib/role-access";
import { findByDatasetRef } from "@/lib/mcp-tools";
import { logger } from "@/lib/logger";
import { mayShare, publishedIsPrivate } from "./audience";
import { draftSlug, getDashboard } from "./meta";

export interface SharedPerson {
  id: string;
  email: string | null;
  name: string | null;
}

/** Someone a dashboard is shared with. `canOpen` is whether the share can take
    effect: false means no role opens the dataset for them yet. */
export interface SharedWith extends SharedPerson {
  canOpen: boolean;
}

export interface SharingState {
  kind: "draft" | "published";
  /** General access. */
  visibility: DraftVisibility;
  isPrivate: boolean;
  /** What to call the dataset in "Everyone on <dataset>". */
  datasetTitle: string;
  /** A draft's author, who always has access. A published dashboard has none. */
  author?: SharedPerson;
  people: SharedWith[];
}

export type SharingResult<T> = { ok: true; value: T } | { ok: false; status: 400 | 403 | 404; error: string };

const refuse = (status: 400 | 403 | 404, error: string) => ({ ok: false as const, status, error });

/**
 * The dashboard, if this person may change who sees it.
 *
 * Through `getDashboard`, so "cannot see it" and "does not exist" are the same
 * 404 here that they are everywhere else. Only then is the question "may you
 * manage it" asked, and that one is a 403: by then they are looking at it.
 */
async function manageable(user: User, datasetRef: string, name: string) {
  const found = await findByDatasetRef(user.id, datasetRef, "view");
  // A branch preview is one admin's own fetch; it has no audience to manage.
  if (!found || "preview" in found) return refuse(404, "dashboard not found");
  const dash = await getDashboard(user.id, datasetRef, name);
  if (!dash) return refuse(404, "dashboard not found");
  const viewer = { id: user.id, admin: hasRole(user, MALLOYYO_ADMIN) };
  if (!mayShare({ isPrivate: dash.isPrivate, authorId: dash.draft?.authorId }, viewer)) {
    return refuse(
      403,
      dash.draft
        ? "only this draft's author or an admin can change who sees it"
        : "only an admin can change who sees this dashboard",
    );
  }
  return { ok: true as const, ds: found.ds, datasetId: found.ds.id, dash };
}

type Managed = Extract<Awaited<ReturnType<typeof manageable>>, { ok: true }>;

/** How many people a dashboard is shared with — for the label beside Share. */
export async function sharedCount(datasetId: string, dashboard: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(dashboardGrants)
    .where(and(eq(dashboardGrants.datasetId, datasetId), eq(dashboardGrants.dashboard, dashboard)));
  return Number(row?.n ?? 0);
}

async function sharedPeople(ds: DatasetGrants, dashboard: string): Promise<SharedWith[]> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      roles: users.roles,
      role: users.role,
      isAdmin: users.isAdmin,
    })
    .from(dashboardGrants)
    .innerJoin(users, eq(users.id, dashboardGrants.userId))
    .where(and(eq(dashboardGrants.datasetId, ds.id), eq(dashboardGrants.dashboard, dashboard)))
    .orderBy(asc(users.email));
  // "Can they actually open it" is the thing the dialog most needs to say about
  // each of them. Worked out from the rows this query already returned, with
  // the same arithmetic the admin page uses (src/lib/role-access.ts, held to
  // the SQL rule by test/dashboard-audience.test.ts) — not asked of the
  // database once per person, which made every open of the dialog and every
  // change in it cost a query for each name on the list.
  return rows.map(({ roles, role, isAdmin, ...p }) => ({
    ...p,
    canOpen: resolveAccess(rolesOf({ roles, role, isAdmin, email: p.email }), [ds], { userId: p.id })[0]!.level !== "none",
  }));
}

/** The dialog's whole state, read fresh — after a write too, so what the
    dialog shows is what is stored, not what the request hoped for. */
async function stateOf(m: Managed, name: string): Promise<SharingState> {
  const people = await sharedPeople(
    {
      id: m.ds.id,
      roles: m.ds.roles,
      viewOnlyRoles: m.ds.viewOnlyRoles,
      ownerId: m.ds.userId,
    },
    name,
  );
  const datasetTitle = m.ds.title?.trim() || m.ds.name;
  if (m.dash.draft) {
    const [draft] = await db
      .select({ visibility: draftDashboards.visibility })
      .from(draftDashboards)
      .where(eq(draftDashboards.id, m.dash.draft.id))
      .limit(1);
    const [author] = await db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, m.dash.draft.authorId))
      .limit(1);
    const visibility = draft?.visibility ?? m.dash.draft.visibility;
    return { kind: "draft", visibility, isPrivate: visibility === "private", datasetTitle, author, people };
  }
  const [ds] = await db
    .select({ stored: datasets.dashboardAudience })
    .from(datasets)
    .where(eq(datasets.id, m.datasetId))
    .limit(1);
  const isPrivate = publishedIsPrivate(name, m.dash.manifest, ds?.stored);
  return { kind: "published", visibility: isPrivate ? "private" : "dataset", isPrivate, datasetTitle, people };
}

export async function getSharing(user: User, datasetRef: string, name: string): Promise<SharingResult<SharingState>> {
  const m = await manageable(user, datasetRef, name);
  if (!m.ok) return m;
  return { ok: true, value: await stateOf(m, name) };
}

/**
 * Share a dashboard with one person, named by email address.
 *
 * By address rather than from a list because a draft's author is an ordinary
 * member, and the roster is not theirs to browse. An address that matches
 * nobody is refused as exactly that.
 *
 * Allowed whatever the general access is: on a dashboard already open to the
 * dataset it changes nothing today, and is who keeps access if it is later made
 * private — the same as adding someone to a document anyone with the link can
 * already read.
 *
 * `warning` is set when the grant was recorded but cannot take effect yet: the
 * person has no role that opens the dataset. The share is kept — an admin often
 * shares the dashboard first and grants the role second — but saying "shared"
 * and nothing else would be a success message over a link that 404s.
 */
export async function shareDashboard(
  user: User,
  datasetRef: string,
  name: string,
  rawEmail: string,
): Promise<SharingResult<SharingState & { warning?: string }>> {
  const m = await manageable(user, datasetRef, name);
  if (!m.ok) return m;
  const email = rawEmail.trim().toLowerCase();
  if (!email) return refuse(400, "an email address is required");
  const [target] = await db
    .select({ id: users.id, status: users.status, email: users.email })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);
  if (!target || target.status !== "active") {
    return refuse(404, `Nobody on this instance signs in as ${email}.`);
  }

  await db
    .insert(dashboardGrants)
    .values({ datasetId: m.datasetId, dashboard: name, userId: target.id, grantedById: user.id })
    .onConflictDoNothing();
  logger.info("dashboard shared", { datasetId: m.datasetId, dashboard: name, userId: target.id, actorId: user.id });

  const state = await stateOf(m, name);
  const reachable = state.people.find((p) => p.id === target.id)?.canOpen ?? false;
  return {
    ok: true,
    value: reachable
      ? state
      : {
          ...state,
          warning:
            `Shared — but ${target.email ?? email} cannot open this dataset yet, so the dashboard will not appear for them. ` +
            "An admin needs to give them a role that opens it (Admin → Users).",
        },
  };
}

export async function unshareDashboard(
  user: User,
  datasetRef: string,
  name: string,
  userId: string,
): Promise<SharingResult<SharingState>> {
  const m = await manageable(user, datasetRef, name);
  if (!m.ok) return m;
  await db
    .delete(dashboardGrants)
    .where(
      and(
        eq(dashboardGrants.datasetId, m.datasetId),
        eq(dashboardGrants.dashboard, name),
        eq(dashboardGrants.userId, userId),
      ),
    );
  logger.info("dashboard unshared", { datasetId: m.datasetId, dashboard: name, userId, actorId: user.id });
  return { ok: true, value: await stateOf(m, name) };
}

/**
 * Set a dashboard's general access: `private`, or open to its `dataset`.
 *
 * A draft's is a column on the draft. A published dashboard's is an entry in
 * its dataset's `dashboard_audience`, which from then on outranks whatever the
 * model's `# artifact` tag says — so the next publish does not undo it.
 */
export async function setDashboardVisibility(
  user: User,
  datasetRef: string,
  name: string,
  visibility: DraftVisibility,
): Promise<SharingResult<SharingState>> {
  const m = await manageable(user, datasetRef, name);
  if (!m.ok) return m;
  if (m.dash.draft && draftSlug(name) !== null) {
    // By id, and deliberately WITHOUT touching updated_at: that column is the
    // draft's content version (the runtime cache key and the edit-conflict
    // check both read it), and who may see a draft is not a change to what it is.
    await db.update(draftDashboards).set({ visibility }).where(eq(draftDashboards.id, m.dash.draft.id));
  } else {
    // One key, set in place: two admins changing two dashboards on the same
    // dataset at once must not write over each other's entry.
    await db
      .update(datasets)
      .set({
        dashboardAudience: sql`jsonb_set(${datasets.dashboardAudience}, array[${name}]::text[], to_jsonb(${visibility}::text))`,
      })
      .where(eq(datasets.id, m.datasetId));
  }
  logger.info("dashboard visibility set", { datasetId: m.datasetId, dashboard: name, visibility, actorId: user.id });
  return { ok: true, value: await stateOf(m, name) };
}
