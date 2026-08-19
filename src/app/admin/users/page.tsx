// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The roster: who may use this instance, managed here rather than in an env
// var. Approval queue first (it is the daily pain), then the admission rule,
// standing invitations, and the members table. Where an integration owns
// sign-in this tab leaves the nav (src/lib/admin-tabs.ts) — membership lives
// with the integration's own people surface — though the route stays reachable
// as a diagnostic view of the local rows.

import { asc, desc, isNull } from "drizzle-orm";
import { db, invitations, users, type User } from "@/db";
import { requireAdminPage } from "@/lib/admin";
import { getAccessPolicy } from "@/lib/access-policy";
import { InviteForm, PolicyPicker, RevokeInviteButton, UserActions } from "./roster-controls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function StatusBadge({ status }: { status: User["status"] }) {
  const cls =
    status === "active"
      ? "text-green-700 dark:text-green-400"
      : status === "pending"
        ? "text-amber-600 dark:text-amber-400"
        : "text-gray-400";
  return <span className={cls}>{status}</span>;
}

const TH = "px-4 py-2 font-medium";
const TD = "px-4 py-2";
const TABLE_WRAP = "border border-gray-200 dark:border-gray-800 rounded overflow-hidden";
const THEAD =
  "bg-gray-50 dark:bg-gray-900 text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-800";

export default async function AdminUsersPage() {
  const me = await requireAdminPage();

  const [rows, openInvites, policy] = await Promise.all([
    db.select().from(users).orderBy(desc(users.createdAt)),
    db.select().from(invitations).where(isNull(invitations.acceptedAt)).orderBy(asc(invitations.createdAt)),
    getAccessPolicy(),
  ]);
  const pending = rows.filter((u) => u.status === "pending");
  const members = rows.filter((u) => u.status !== "pending");

  return (
    <div className="space-y-10">
      {pending.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs uppercase tracking-wide text-amber-600 dark:text-amber-400">
            Waiting for approval
          </h2>
          <div className="border border-amber-300 dark:border-amber-700 rounded overflow-hidden">
            <table className="w-full text-xs">
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {pending.map((u) => (
                  <tr key={u.id}>
                    <td className={TD}>{u.name ?? <span className="text-gray-400">—</span>}</td>
                    <td className={`${TD} text-gray-600 dark:text-gray-400`}>{u.email ?? "—"}</td>
                    <td className={`${TD} text-gray-400`}>{u.createdAt.toISOString().slice(0, 10)}</td>
                    <td className={`${TD} text-right`}>
                      <UserActions userId={u.id} status={u.status} role={u.role} isSelf={u.id === me.id} label={u.name ?? u.email ?? "this user"} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Who may join</h2>
        <PolicyPicker current={policy} />
      </section>

      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Invite</h2>
        <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
          An invited address is admitted the moment it first signs in — no approval step.
        </p>
        <InviteForm />
        {openInvites.length > 0 && (
          <div className={TABLE_WRAP}>
            <table className="w-full text-xs">
              <thead>
                <tr className={THEAD}>
                  <th className={TH}>invited</th>
                  <th className={TH}>role</th>
                  <th className={TH}>since</th>
                  <th className={TH}></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {openInvites.map((i) => (
                  <tr key={i.id}>
                    <td className={`${TD} text-gray-600 dark:text-gray-400`}>{i.email}</td>
                    <td className={TD}>{i.role}</td>
                    <td className={`${TD} text-gray-400`}>{i.createdAt.toISOString().slice(0, 10)}</td>
                    <td className={`${TD} text-right`}>
                      <RevokeInviteButton id={i.id} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Members</h2>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {members.length} member{members.length !== 1 ? "s" : ""}
        </p>
        <div className={TABLE_WRAP}>
          <table className="w-full text-xs">
            <thead>
              <tr className={THEAD}>
                <th className={TH}>name</th>
                <th className={TH}>email</th>
                <th className={TH}>role</th>
                <th className={TH}>status</th>
                <th className={TH}>joined</th>
                <th className={TH}></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {members.map((u) => (
                <tr key={u.id} className="hover:bg-gray-50 dark:hover:bg-gray-900/50">
                  <td className={TD}>
                    {u.name ?? <span className="text-gray-400">—</span>}
                    {u.id === me.id && <span className="ml-1 text-gray-400">(you)</span>}
                  </td>
                  <td className={`${TD} text-gray-600 dark:text-gray-400`}>{u.email ?? <span className="text-gray-400">—</span>}</td>
                  <td className={TD}>{u.role}</td>
                  <td className={TD}><StatusBadge status={u.status} /></td>
                  <td className={`${TD} text-gray-400`}>{u.createdAt.toISOString().slice(0, 10)}</td>
                  <td className={`${TD} text-right`}>
                    <UserActions userId={u.id} status={u.status} role={u.role} isSelf={u.id === me.id} label={u.name ?? u.email ?? "this user"} />
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
