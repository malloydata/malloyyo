// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Roles: what people may do, and which datasets they may open.
//
// Ordered the way the question is usually asked — what roles exist, what each
// one opens, who holds it — with the new-arrival default last, because it is
// set once and then forgotten.

import { asc, desc, eq } from "drizzle-orm";
import { db, datasets, givens as givensTable, roles as rolesTable, users } from "@/db";
import { requireAdminPage } from "@/lib/admin";
import { defaultRoles, isBuiltinRole, NEVER_A_DEFAULT, rolesOf } from "@/lib/roles";
import {
  DatasetGivens,
  DefaultRoles,
  DeleteRoleButton,
  NewRoleForm,
  RoleDatasets,
  UserRoles,
} from "./role-controls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TH = "px-4 py-2 font-medium";
const TD = "px-4 py-2 align-top";
const TABLE_WRAP = "border border-gray-200 dark:border-gray-800 rounded overflow-hidden";
const THEAD =
  "bg-gray-50 dark:bg-gray-900 text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-800";

export default async function AdminRolesPage() {
  await requireAdminPage();

  const [catalog, dsRows, people, fallback, givenCatalog] = await Promise.all([
    db.select().from(rolesTable).orderBy(asc(rolesTable.builtin), asc(rolesTable.name)),
    // Ready datasets only. A failed or half-built row cannot be opened by
    // anyone, and listing it here means two checkboxes with the same label and
    // no way to tell which is which.
    db
      .select({
        id: datasets.id,
        name: datasets.name,
        roles: datasets.roles,
        requiredGivens: datasets.requiredGivens,
      })
      .from(datasets)
      .where(eq(datasets.status, "ready"))
      .orderBy(asc(datasets.name)),
    db.select().from(users).orderBy(desc(users.createdAt)),
    defaultRoles(),
    db.select().from(givensTable).orderBy(asc(givensTable.name)),
  ]);

  const allRoleNames = catalog.map((r) => r.name);
  const allDatasets = dsRows.map((d) => ({ id: d.id, name: d.name }));
  const members = people.filter((u) => u.status !== "pending");
  const holders = (role: string) => members.filter((u) => rolesOf(u).includes(role)).length;
  const grantedFor = (role: string) =>
    dsRows.filter((d) => (d.roles ?? []).includes(role)).map((d) => d.id);

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-medium">Roles</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 max-w-2xl">
            A role decides which datasets someone may open. Everything a dataset publishes, a
            holder gets — so if two groups need different sources, that is two datasets. The
            two <code className="text-[11px]">MALLOYYO_</code> roles are built in and say what
            someone may <em>do</em> here; the rest are yours, and are best named after groups of
            people.
          </p>
        </div>

        <NewRoleForm />

        <div className={TABLE_WRAP}>
          <table className="w-full text-sm">
            <thead className={THEAD}>
              <tr>
                <th className={TH}>Role</th>
                <th className={TH}>Opens</th>
                <th className={TH}>Held by</th>
                <th className={TH} />
              </tr>
            </thead>
            <tbody>
              {catalog.map((role) => (
                <tr key={role.name} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                  <td className={TD}>
                    <div className="font-mono text-xs">{role.name}</div>
                    {role.description && (
                      <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 max-w-sm">
                        {role.description}
                      </div>
                    )}
                  </td>
                  <td className={TD}>
                    <RoleDatasets
                      key={grantedFor(role.name).join(",")}
                      name={role.name}
                      all={allDatasets}
                      granted={grantedFor(role.name)}
                    />
                  </td>
                  <td className={`${TD} text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap`}>
                    {holders(role.name)}
                  </td>
                  <td className={`${TD} text-right`}>
                    {isBuiltinRole(role.name) ? (
                      <span className="text-xs text-gray-400">built in</span>
                    ) : (
                      <DeleteRoleButton name={role.name} holders={holders(role.name)} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-medium">Who holds what</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 max-w-2xl">
            Changing someone&rsquo;s roles takes effect on their next request. Removing the last
            role that opens a dataset removes the dataset from their view entirely — it stops
            being listed, not just refused.
          </p>
        </div>
        <div className={TABLE_WRAP}>
          <table className="w-full text-sm">
            <thead className={THEAD}>
              <tr>
                <th className={TH}>Person</th>
                <th className={TH}>Roles</th>
              </tr>
            </thead>
            <tbody>
              {members.map((u) => (
                <tr key={u.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                  <td className={TD}>
                    <div>{u.name ?? u.email ?? u.id.slice(0, 8)}</div>
                    {u.name && u.email && (
                      <div className="text-xs text-gray-500 dark:text-gray-400">{u.email}</div>
                    )}
                  </td>
                  <td className={TD}>
                    <UserRoles
                      key={rolesOf(u).join(",")}
                      userId={u.id}
                      all={allRoleNames}
                      held={rolesOf(u)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-medium">What each dataset is scoped by</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 max-w-2xl">
            Rows inside a dataset, narrowed to whoever is asking. Tick one and every model
            published here must declare it — a publish that does not is refused rather than
            serving the data unscoped. Leave them clear for a dataset everyone with a role sees
            in full.
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
                  <td className={TD}>{d.name}</td>
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
          <h2 className="text-sm font-medium">New arrivals get</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 max-w-2xl">
            Granted when someone is first admitted. Keep this narrow — with no
            dataset-bearing role here, a new person can sign in and sees nothing until someone
            grants them one deliberately. <code className="text-[11px]">MALLOYYO_ADMIN</code> is
            not offered: on an open instance this list is applied to everyone who signs in.
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
