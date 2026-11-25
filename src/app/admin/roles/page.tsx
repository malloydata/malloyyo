// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Roles: what people may do, and which datasets they may open.
//
// Ordered the way the question is usually asked — what roles exist, what each
// one opens, who holds it — with the new-arrival default last, because it is
// set once and then forgotten.

import { asc, desc, eq } from "drizzle-orm";
import { dashboardGrants, db, datasets, givens as givensTable, roles as rolesTable, users } from "@/db";
import { requireAdminPage } from "@/lib/admin";
import { defaultRoles, MALLOYYO_ADMIN, NEVER_A_DEFAULT, rolesOf } from "@/lib/roles";
import { datasetTitle } from "@malloyyo/mcp-engine";
import { DatasetGivens, DefaultRoles } from "./role-controls";
import { PeoplePanel, RolesPanel, type SharedDashboard } from "./roles-workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TH = "px-4 py-2 font-medium";
const TD = "px-4 py-2 align-top";
const TABLE_WRAP = "border border-gray-200 dark:border-gray-800 rounded overflow-hidden";
const THEAD =
  "bg-gray-50 dark:bg-gray-900 text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-800";

export default async function AdminRolesPage() {
  const me = await requireAdminPage();

  const [catalog, dsRows, people, fallback, givenCatalog, grants] = await Promise.all([
    db.select().from(rolesTable).orderBy(asc(rolesTable.builtin), asc(rolesTable.name)),
    // Ready datasets only. A failed or half-built row cannot be opened by
    // anyone, and listing it here means two rows with the same label and no
    // way to tell which is which.
    db
      .select({
        id: datasets.id,
        name: datasets.name,
        title: datasets.title,
        description: datasets.description,
        roles: datasets.roles,
        viewOnlyRoles: datasets.viewOnlyRoles,
        isPublic: datasets.isPublic,
        ownerId: datasets.userId,
        requiredGivens: datasets.requiredGivens,
      })
      .from(datasets)
      .where(eq(datasets.status, "ready"))
      .orderBy(asc(datasets.name)),
    db.select().from(users).orderBy(desc(users.createdAt)),
    defaultRoles(),
    db.select().from(givensTable).orderBy(asc(givensTable.name)),
    // Private dashboards shared with people by email — shown beside each
    // person, because a role change can strand one.
    db
      .select({
        userId: dashboardGrants.userId,
        datasetId: dashboardGrants.datasetId,
        dashboard: dashboardGrants.dashboard,
      })
      .from(dashboardGrants),
  ]);

  const allRoleNames = catalog.map((r) => r.name);
  // Title for reading, NAME underneath. This page is where access is decided,
  // and titles are not unique — two datasets may both be called "Sales", and a
  // row you cannot tell apart is a level set on the wrong one.
  const allDatasets = dsRows.map((d) => ({
    id: d.id,
    name: d.name,
    title: datasetTitle(d.name, d.title),
    roles: d.roles ?? [],
    viewOnlyRoles: d.viewOnlyRoles ?? [],
    isPublic: d.isPublic,
    ownerId: d.ownerId,
  }));
  const members = people
    .filter((u) => u.status !== "pending")
    .map((u) => {
      // `rolesOf`, not the bare column: it folds in the older ways of being an
      // admin, so this page and every access check name the same people.
      const held = rolesOf(u);
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        roles: held,
        isAdmin: held.includes(MALLOYYO_ADMIN),
        isOwner: u.role === "owner",
        isSelf: u.id === me.id,
      };
    });
  const shared: Record<string, SharedDashboard[]> = {};
  for (const g of grants) (shared[g.userId] ??= []).push({ datasetId: g.datasetId, dashboard: g.dashboard });
  const roleRows = catalog.map((r) => ({ name: r.name, description: r.description, builtin: r.builtin }));

  return (
    <div className="flex flex-col gap-10">
      <RolesPanel roles={roleRows} datasets={allDatasets} people={members} canViewAs />

      <PeoplePanel people={members} roles={roleRows} datasets={allDatasets} shared={shared} canViewAs />

      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-medium">What each dataset is scoped by</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 max-w-2xl">
            Narrows the rows inside a dataset to whoever is asking. Tick one and every model
            published here has to declare it; a publish that does not is refused. Leave them
            clear and anyone with a role sees the whole dataset.
          </p>
        </div>
        <div className={TABLE_WRAP}>
          <table className="w-full text-sm">
            <thead className={THEAD}>
              <tr>
                <th className={TH}>Dataset</th>
                <th className={TH}>Scoped by</th>
              </tr>
            </thead>
            <tbody>
              {dsRows.map((d) => (
                <tr key={d.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                  <td className={TD}>
                    <div>{datasetTitle(d.name, d.title)}</div>
                    <div className="font-mono text-xs text-gray-500 dark:text-gray-400">{d.name}</div>
                    {/* What it IS — the question an admin is actually asking
                        when deciding who should see it. */}
                    {d.description && (
                      <div className="mt-0.5 max-w-md text-xs text-gray-500 dark:text-gray-400">
                        {d.description}
                      </div>
                    )}
                  </td>
                  <td className={TD}>
                    <DatasetGivens
                      key={(d.requiredGivens ?? []).join(",")}
                      datasetId={d.id}
                      all={givenCatalog.map((g) => ({ name: g.name, description: g.description }))}
                      required={d.requiredGivens ?? []}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <div>
          <h2 className="text-sm font-medium">New users get</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 max-w-2xl">
            The roles someone holds the first time they sign in. If none of them opens a
            dataset, a new person signs in to an empty page until you give them a role.
          </p>
        </div>
        <DefaultRoles
          key={fallback.join(",")}
          all={allRoleNames.filter((r) => !NEVER_A_DEFAULT.includes(r))}
          current={fallback}
        />
      </section>
    </div>
  );
}
