// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * Who may open one dashboard — the layer UNDER dataset access.
 *
 * A dashboard is either open to everyone who can open its dataset, or PRIVATE:
 *
 *   published  private when its stored setting says so, and until one is set,
 *              when its tag does — `# artifact { private }`
 *   draft      private until its author opens it (`draft_dashboards.visibility`)
 *
 * One setting, changed in one place (the Share dialog), for both kinds — so
 * promoting a draft copies its audience across and changes nothing about who
 * can see it.
 *
 * A private dashboard is seen by admins, by its author (a draft has one; a
 * modeled dashboard's author is the repo), and by the people it has been shared
 * with one at a time (`dashboard_grants`).
 *
 * THIS IS CURATION, NOT A SECURITY BOUNDARY, and the code must not start
 * treating it as one. The dataset is the unit of access (docs/roles-and-access.md):
 * anyone who can open one dashboard on a dataset can already run restricted
 * Malloy against all of it through that dashboard's run route. So a grant never
 * lets anyone into a dataset — every caller here has resolved the dataset for
 * the viewer first — and hiding a dashboard hides a view, not the rows behind
 * it. Data two groups must not share belongs in two datasets.
 *
 * DB-only, like ./meta, which is its main caller: no Malloy, no DuckDB.
 */

import { and, eq, inArray } from "drizzle-orm";
import { dashboardGrants, db, users } from "@/db";
import { hasRole, MALLOYYO_ADMIN } from "@/lib/roles";

/** What decides who may open one dashboard. */
export interface Audience {
  isPrivate?: boolean;
  /** A draft's author, who always sees their own. */
  authorId?: string;
}

/** `# artifact { private }`, as the stored manifest carries it. */
export function isPrivateManifest(manifest: Record<string, unknown> | null | undefined): boolean {
  return manifest?.private === true;
}

/** The stored audience of a dataset's published dashboards, by name
    (`datasets.dashboard_audience`). */
export type AudienceMap = Record<string, "private" | "dataset"> | null | undefined;

/**
 * Whether a PUBLISHED dashboard is private.
 *
 * The stored setting when there is one — what the Share dialog wrote, or what
 * promoting a draft copied over — and otherwise what the model's tag says. So
 * the tag decides what a dashboard starts as and nothing after that, which is
 * what lets a draft keep its audience across promotion whatever the promoted
 * file's tag happens to say.
 */
export function publishedIsPrivate(
  name: string,
  manifest: Record<string, unknown> | null | undefined,
  stored: AudienceMap,
): boolean {
  const setting = stored?.[name];
  if (setting === "private") return true;
  if (setting === "dataset") return false;
  return isPrivateManifest(manifest);
}

/** Whether opening it takes more than being able to open the dataset. A
    viewer's own draft never does, which is what lets the common listing —
    public dashboards and your own drafts — skip the lookups below entirely. */
export function isRestrictedFor(a: Audience, viewerId: string): boolean {
  return a.isPrivate === true && a.authorId !== viewerId;
}

/** The rule, in one place. `granted`: it was shared with this viewer. */
export function mayOpen(a: Audience, viewer: { id: string; admin: boolean }, granted: boolean): boolean {
  return !isRestrictedFor(a, viewer.id) || viewer.admin || granted;
}

/** Who may change a dashboard's audience: an admin, or a draft's own author.
    A modeled dashboard's privacy is set in the model, so only its people list
    is editable here, and only by an admin. */
export function mayShare(a: Audience, viewer: { id: string; admin: boolean }): boolean {
  return viewer.admin || (a.authorId !== undefined && a.authorId === viewer.id);
}

/** Read on this request, like every other authority check: a demoted admin
    stops seeing other people's private dashboards on the next one. */
export async function isAdminUser(userId: string): Promise<boolean> {
  const [u] = await db
    .select({ roles: users.roles, role: users.role, isAdmin: users.isAdmin, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return !!u && hasRole(u, MALLOYYO_ADMIN);
}

const grantKey = (datasetId: string, dashboard: string) => `${datasetId}\u0000${dashboard}`;

/**
 * A predicate for "may this viewer see this dashboard", over a listing.
 *
 * `restrictedIn` is the datasets holding something `isRestrictedFor` the
 * viewer. EMPTY means nothing listed needs a decision, and that costs no query
 * — which matters, because listings run on every page (the nav tree measured
 * six seconds before its round trips were counted; see allDashboardsByDataset).
 * Otherwise it is two reads, issued together.
 *
 * `datasetId` is the dataset's real id, never the ref a URL carried: grants are
 * stored against the id.
 */
export async function audienceFilter(
  userId: string,
  restrictedIn: readonly string[],
): Promise<(datasetId: string, d: Audience & { name: string }) => boolean> {
  if (restrictedIn.length === 0) return () => true;
  const [admin, grants] = await Promise.all([
    isAdminUser(userId),
    db
      .select({ datasetId: dashboardGrants.datasetId, dashboard: dashboardGrants.dashboard })
      .from(dashboardGrants)
      .where(and(eq(dashboardGrants.userId, userId), inArray(dashboardGrants.datasetId, [...new Set(restrictedIn)]))),
  ]);
  if (admin) return () => true;
  const granted = new Set(grants.map((g) => grantKey(g.datasetId, g.dashboard)));
  const viewer = { id: userId, admin: false };
  return (datasetId, d) => mayOpen(d, viewer, granted.has(grantKey(datasetId, d.name)));
}

/** One dataset's listing, filtered to what the viewer may see. */
export async function visibleDashboards<T extends Audience & { name: string }>(
  userId: string,
  datasetId: string,
  list: T[],
): Promise<T[]> {
  const restricted = list.some((d) => isRestrictedFor(d, userId));
  const allow = await audienceFilter(userId, restricted ? [datasetId] : []);
  return list.filter((d) => allow(datasetId, d));
}

/** The same decision for ONE dashboard — what `getDashboard` asks. */
export async function mayOpenDashboard(
  userId: string,
  datasetId: string,
  d: Audience & { name: string },
): Promise<boolean> {
  return (await visibleDashboards(userId, datasetId, [d])).length === 1;
}
