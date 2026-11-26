// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Admin → Users: who may use this instance, and what each of them can reach.
//
// One list and one button. A person's row says the roles they hold and what
// those add up to; it opens to show why, to change the roles, and to disable
// them. "Add user" takes an address and the roles that person starts with.
// People waiting for approval are a strip above the list that is only there
// while someone is waiting.
//
// What a role opens is Admin → Roles; a dataset's repo and row scoping are
// Admin → Datasets. This page was once all three at the same time, seven
// sections deep.
//
// WHERE AN INTEGRATION OWNS SIGN-IN, membership is decided there: Add user,
// the approval strip, Disable/Enable and the admission policy are left out.
// The list stays, because which roles those people hold — and so which
// datasets they open — is still this instance's to say.

import { asc, desc, eq, isNull } from "drizzle-orm";
import { dashboardGrants, db, datasets, invitations, roles as rolesTable, users } from "@/db";
import { requireAdminPage } from "@/lib/admin";
import { getAccessPolicy } from "@/lib/access-policy";
import { hostedSignIn } from "@/lib/hosted-auth-integration";
import { defaultRoles, MALLOYYO_ADMIN, rolesOf } from "@/lib/roles";
import { datasetTitle } from "@malloyyo/mcp-engine";
import { MUTED, type InvitedRow, type SharedDashboard } from "../access-shared";
import { AddUserButton } from "./add-user";
import { PeoplePanel } from "./people-panel";
import { PolicyPicker, UserActions } from "./roster-controls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string | string[] }>;
}) {
  const me = await requireAdminPage();
  const { role } = await searchParams;

  // Whether membership is this application's to manage.
  const ownsSignIn = !hostedSignIn();

  const [catalog, dsRows, people, fallback, grants, openInvites, policy] = await Promise.all([
    db.select().from(rolesTable).orderBy(asc(rolesTable.builtin), asc(rolesTable.name)),
    // Ready datasets only: a failed or half-built row cannot be opened by
    // anyone, so it is not part of what anyone gets.
    db
      .select({
        id: datasets.id,
        name: datasets.name,
        title: datasets.title,
        roles: datasets.roles,
        viewOnlyRoles: datasets.viewOnlyRoles,
        ownerId: datasets.userId,
      })
      .from(datasets)
      .where(eq(datasets.status, "ready"))
      .orderBy(asc(datasets.name)),
    db.select().from(users).orderBy(desc(users.createdAt)),
    defaultRoles(),
    // Private dashboards shared with people by email — shown inside a person's
    // row, because a role change can strand one.
    db
      .select({
        userId: dashboardGrants.userId,
        datasetId: dashboardGrants.datasetId,
        dashboard: dashboardGrants.dashboard,
      })
      .from(dashboardGrants),
    ownsSignIn
      ? db.select().from(invitations).where(isNull(invitations.acceptedAt)).orderBy(desc(invitations.createdAt))
      : Promise.resolve([]),
    ownsSignIn ? getAccessPolicy() : Promise.resolve(null),
  ]);

  const pending = ownsSignIn ? people.filter((u) => u.status === "pending") : [];
  const roleRows = catalog.map((r) => ({ name: r.name, description: r.description, builtin: r.builtin }));
  const allDatasets = dsRows.map((d) => ({
    id: d.id,
    name: d.name,
    title: datasetTitle(d.name, d.title),
    roles: d.roles ?? [],
    viewOnlyRoles: d.viewOnlyRoles ?? [],
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
  const nameOf = new Map(people.map((u) => [u.id, u.id === me.id ? "you" : (u.name ?? u.email)]));
  const invited: InvitedRow[] = openInvites.map((i) => {
    // What they will hold on arrival, worked out the way admission does it
    // (src/lib/admission.ts): the roles ticked when they were added, or the
    // instance default where nobody ticked any; plus the admin role when the
    // older member/admin flag says so.
    const held = i.roles ?? fallback;
    return {
      id: i.id,
      email: i.email,
      roles: i.role === "member" || held.includes(MALLOYYO_ADMIN) ? held : [...held, MALLOYYO_ADMIN],
      addedOn: i.createdAt.toISOString().slice(0, 10),
      addedBy: (i.invitedById && nameOf.get(i.invitedById)) || null,
    };
  });
  const shared: Record<string, SharedDashboard[]> = {};
  for (const g of grants) (shared[g.userId] ??= []).push({ datasetId: g.datasetId, dashboard: g.dashboard });

  const count = members.length + invited.length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2.5">
          <h2 className="text-base font-semibold">Users</h2>
          <span className={MUTED}>
            {count} {count === 1 ? "person" : "people"}
          </span>
        </div>
        {ownsSignIn && <AddUserButton roles={roleRows} datasets={allDatasets} defaults={fallback} />}
      </div>

      {pending.length > 0 && (
        <section
          aria-label="Waiting for approval"
          className="flex flex-col rounded-md border border-amber-600 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40"
        >
          <h3 className="px-4 pt-2.5 text-xs font-semibold text-amber-800 dark:text-amber-300">
            Waiting for approval
          </h3>
          {pending.map((u) => (
            <div key={u.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2">
              <span className="min-w-0">
                <span className="text-sm">{u.name ?? u.email ?? "someone with no name or address"}</span>{" "}
                <span className={MUTED}>
                  {u.name && u.email ? `${u.email} · ` : ""}asked {u.createdAt.toISOString().slice(0, 10)}
                </span>
              </span>
              <UserActions
                userId={u.id}
                status={u.status}
                role={u.role}
                isSelf={u.id === me.id}
                label={u.name ?? u.email ?? "this user"}
              />
            </div>
          ))}
        </section>
      )}

      <PeoplePanel
        people={members}
        invited={invited}
        roles={roleRows}
        datasets={allDatasets}
        shared={shared}
        canViewAs
        manageMembership={ownsSignIn}
        initialRole={typeof role === "string" ? role : undefined}
      />

      {ownsSignIn && policy && <PolicyPicker current={policy} />}
    </div>
  );
}
