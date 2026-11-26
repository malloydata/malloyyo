// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Users & roles: who may use this instance, what each of them can reach, and
// what each role opens.
//
// One page, because it is one question. This used to be two tabs — "Users"
// (the roster: approve, invite, disable, make admin) and "Roles" (what roles
// open, and who holds them) — which listed the same people twice and gave
// "is an admin" two controls. Now a person has one row: their roles, what
// those add up to, and whether they may sign in.
//
// Ordered by how often each part is used: people waiting to be let in, then
// the people and what they get, then the roles themselves, then the settings
// that are made once (what new arrivals get, who may join, row scoping).
//
// WHERE AN INTEGRATION OWNS SIGN-IN, membership is decided there, not here:
// the approval queue, invitations, the admission policy and Disable/Enable are
// left out, and the tab is called "Roles" (src/lib/admin-tabs.ts). Which
// datasets those people may open is still this instance's to say, so
// everything else is the same.

import { asc, desc, eq, isNull } from "drizzle-orm";
import {
  dashboardGrants,
  db,
  datasets,
  givens as givensTable,
  invitations,
  roles as rolesTable,
  users,
} from "@/db";
import { requireAdminPage } from "@/lib/admin";
import { getAccessPolicy } from "@/lib/access-policy";
import { hostedSignIn } from "@/lib/hosted-auth-integration";
import { InviteForm, PolicyPicker, RevokeInviteButton, UserActions } from "../users/roster-controls";
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

  // Whether membership is this application's to manage. Where an integration
  // owns sign-in it is not, and the admission controls below are left out.
  const ownsSignIn = !hostedSignIn();

  const [catalog, dsRows, people, fallback, givenCatalog, grants, openInvites, policy] = await Promise.all([
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
    ownsSignIn
      ? db.select().from(invitations).where(isNull(invitations.acceptedAt)).orderBy(asc(invitations.createdAt))
      : Promise.resolve([]),
    ownsSignIn ? getAccessPolicy() : Promise.resolve(null),
  ]);
  const pending = ownsSignIn ? people.filter((u) => u.status === "pending") : [];

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
        status: u.status === "disabled" ? ("disabled" as const) : ("active" as const),
      };
    });
  const shared: Record<string, SharedDashboard[]> = {};
  for (const g of grants) (shared[g.userId] ??= []).push({ datasetId: g.datasetId, dashboard: g.dashboard });
  const roleRows = catalog.map((r) => ({ name: r.name, description: r.description, builtin: r.builtin }));

  return (
    <div className="flex flex-col gap-10">
      {pending.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-amber-700 dark:text-amber-400">Waiting for approval</h2>
          <div className="overflow-hidden rounded border border-amber-300 dark:border-amber-700">
            <table className="w-full text-xs">
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {pending.map((u) => (
                  <tr key={u.id}>
                    <td className="px-4 py-2">{u.name ?? <span className="text-gray-400">—</span>}</td>
                    <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{u.email ?? "—"}</td>
                    <td className="px-4 py-2 text-gray-500">{u.createdAt.toISOString().slice(0, 10)}</td>
                    <td className="px-4 py-2 text-right">
                      <UserActions
                        userId={u.id}
                        status={u.status}
                        role={u.role}
                        isSelf={u.id === me.id}
                        label={u.name ?? u.email ?? "this user"}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <PeoplePanel
        people={members}
        roles={roleRows}
        datasets={allDatasets}
        shared={shared}
        canViewAs
        manageMembership={ownsSignIn}
      />

      <RolesPanel roles={roleRows} datasets={allDatasets} people={members} canViewAs />

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

      {ownsSignIn && policy && (
        <section className="flex flex-col gap-3">
          <div>
            <h2 className="text-sm font-medium">Invite</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 max-w-2xl">
              An invited address is admitted the moment it first signs in, with no approval step, and gets
              the roles under &ldquo;New users get&rdquo;.
            </p>
          </div>
          <InviteForm />
          {openInvites.length > 0 && (
            <div className={TABLE_WRAP}>
              <table className="w-full text-xs">
                <thead className={THEAD}>
                  <tr>
                    <th className={TH}>invited</th>
                    <th className={TH}>role</th>
                    <th className={TH}>since</th>
                    <th className={TH} />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {openInvites.map((i) => (
                    <tr key={i.id}>
                      <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{i.email}</td>
                      <td className="px-4 py-2">{i.role}</td>
                      <td className="px-4 py-2 text-gray-500">{i.createdAt.toISOString().slice(0, 10)}</td>
                      <td className="px-4 py-2 text-right">
                        <RevokeInviteButton id={i.id} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {ownsSignIn && policy && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium">Who may join</h2>
          <PolicyPicker current={policy} />
        </section>
      )}

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
    </div>
  );
}
