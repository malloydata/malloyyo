// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * Changing who sees a dashboard — the write side of ./audience.
 *
 * Two levers, and which one applies depends on what the dashboard is:
 *
 *   a draft      its author (or an admin) flips it between `private` and
 *                `dataset`, and shares a private one with people
 *   a modeled    whether it is private is the MODEL's to say
 *   dashboard    (`# artifact { private }`); an admin shares a private one
 *                with people
 *
 * Nothing here opens a dataset. A person a dashboard is shared with still has
 * to be able to open the dataset it is built on, and sharing with someone who
 * cannot says so rather than appearing to work — see `shareDashboard`.
 *
 * DB-only: no Malloy, no DuckDB, so a page may import it.
 */

import { and, asc, eq, sql } from "drizzle-orm";
import { dashboardGrants, datasets, db, draftDashboards, users, type DraftVisibility, type User } from "@/db";
import { hasRole, MALLOYYO_ADMIN } from "@/lib/roles";
import { findByDatasetRef, visibleDatasetWhere } from "@/lib/mcp-tools";
import { logger } from "@/lib/logger";
import { mayShare } from "./audience";
import { draftSlug, getDashboard } from "./meta";

export interface SharedPerson {
  id: string;
  email: string | null;
  name: string | null;
}

export interface SharingState {
  kind: "draft" | "modeled";
  isPrivate: boolean;
  /** Drafts only — the lever its author holds. */
  visibility?: DraftVisibility;
  /** Who it has been shared with. Meaningful while it is private; kept (and
      shown again) if a draft is opened to the dataset and later closed. */
  people: SharedPerson[];
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
  const found = await findByDatasetRef(user.id, datasetRef);
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
  return { ok: true as const, datasetId: found.ds.id, dash };
}

async function sharedPeople(datasetId: string, dashboard: string): Promise<SharedPerson[]> {
  return db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(dashboardGrants)
    .innerJoin(users, eq(users.id, dashboardGrants.userId))
    .where(and(eq(dashboardGrants.datasetId, datasetId), eq(dashboardGrants.dashboard, dashboard)))
    .orderBy(asc(users.email));
}

function stateOf(dash: NonNullable<Awaited<ReturnType<typeof getDashboard>>>, people: SharedPerson[]): SharingState {
  return dash.draft
    ? { kind: "draft", isPrivate: dash.draft.visibility === "private", visibility: dash.draft.visibility, people }
    : { kind: "modeled", isPrivate: dash.isPrivate === true, people };
}

export async function getSharing(user: User, datasetRef: string, name: string): Promise<SharingResult<SharingState>> {
  const m = await manageable(user, datasetRef, name);
  if (!m.ok) return m;
  return { ok: true, value: stateOf(m.dash, await sharedPeople(m.datasetId, name)) };
}

/**
 * Share a dashboard with one person, named by email address.
 *
 * By address rather than from a list because a draft's author is an ordinary
 * member, and the roster is not theirs to browse. An address that matches
 * nobody is refused as exactly that.
 *
 * `warning` is set when the grant was recorded but cannot take effect yet: the
 * person has no role that opens the dataset. The share is kept — an admin often
 * grants the dashboard first and the role second — but saying "shared" and
 * nothing else would be a success message over a link that 404s.
 */
export async function shareDashboard(
  user: User,
  datasetRef: string,
  name: string,
  rawEmail: string,
): Promise<SharingResult<SharingState & { warning?: string }>> {
  const m = await manageable(user, datasetRef, name);
  if (!m.ok) return m;
  if (!m.dash.draft && !m.dash.isPrivate) {
    return refuse(
      400,
      "this dashboard is open to everyone who can open the dataset. To share it person by person, " +
        "tag it private in the model — `# artifact { private }` — and publish.",
    );
  }
  const email = rawEmail.trim().toLowerCase();
  if (!email) return refuse(400, "an email address is required");
  const [target] = await db
    .select({ id: users.id, status: users.status, email: users.email })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);
  if (!target || target.status !== "active") {
    return refuse(404, `nobody on this instance signs in as ${email}`);
  }

  await db
    .insert(dashboardGrants)
    .values({ datasetId: m.datasetId, dashboard: name, userId: target.id, grantedById: user.id })
    .onConflictDoNothing();
  logger.info("dashboard shared", { datasetId: m.datasetId, dashboard: name, userId: target.id, actorId: user.id });

  const [reachable] = await db
    .select({ id: datasets.id })
    .from(datasets)
    .where(and(visibleDatasetWhere(target.id), eq(datasets.id, m.datasetId)))
    .limit(1);
  const state = stateOf(m.dash, await sharedPeople(m.datasetId, name));
  return {
    ok: true,
    value: reachable
      ? state
      : {
          ...state,
          warning:
            `Shared — but ${target.email ?? email} cannot open this dataset yet, so the dashboard will not appear for them. ` +
            "An admin needs to give them a role that opens it (Admin → Roles).",
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
  return { ok: true, value: stateOf(m.dash, await sharedPeople(m.datasetId, name)) };
}

/** Open a draft to its dataset, or close it again. Drafts only: a modeled
    dashboard's privacy is a line in the model, and a toggle here would be a
    second answer to the same question that the next publish silently undoes. */
export async function setDraftVisibility(
  user: User,
  datasetRef: string,
  name: string,
  visibility: DraftVisibility,
): Promise<SharingResult<SharingState>> {
  const m = await manageable(user, datasetRef, name);
  if (!m.ok) return m;
  const slug = draftSlug(name);
  if (!m.dash.draft || slug === null) {
    return refuse(
      400,
      "a modeled dashboard's audience is set in the model: add or remove `private` on its `# artifact` tag and publish",
    );
  }
  // By id, and deliberately WITHOUT touching updated_at: that column is the
  // draft's content version (the runtime cache key and the edit-conflict check
  // both read it), and who may see a draft is not a change to what it is.
  await db.update(draftDashboards).set({ visibility }).where(eq(draftDashboards.id, m.dash.draft.id));
  logger.info("draft visibility set", { draftId: m.dash.draft.id, visibility, actorId: user.id });
  return {
    ok: true,
    value: {
      kind: "draft",
      isPrivate: visibility === "private",
      visibility,
      people: await sharedPeople(m.datasetId, name),
    },
  };
}
