// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";

// Admin → Users: the list. Each person, the roles they hold, and WHAT THAT
// ADDS UP TO. A row opens to show why, to edit the roles with the result
// previewed before anything is saved, and to disable or enable them.
//
// Someone added who has not signed in yet is a row like any other — they ARE a
// user from the moment they are added (src/lib/roster.ts) — tagged so, and
// removable outright, since nothing of theirs exists yet.
//
// Nothing here decides access — every write goes to an admin API that
// re-checks it.

import { useState } from "react";
import { LEVEL_LABEL, resolveAccess } from "@/lib/role-access";
import { ViewAsButton } from "@/components/ViewAsButton";
import {
  ADMIN,
  AccessSummary,
  describeRole,
  HEADING,
  LevelBadge,
  MUTED,
  personLabel,
  RoleChip,
  type DatasetRow,
  type PersonRow,
  type RoleRow,
  type SharedDashboard,
} from "../access-shared";
import { BTN, INPUT, useAction } from "../roles/role-controls";
import { RemoveAddedButton, UserActions } from "./roster-controls";

// The last column is as wide as its one button. "What they get" has the rest:
// it is the column the page is for, and its lists are what wrap.
const GRID = "grid grid-cols-[11rem_8.75rem_minmax(0,1fr)_6.25rem] gap-4";
const TAG = "shrink-0 rounded border border-gray-400 px-1 text-xs text-gray-600 dark:border-gray-600 dark:text-gray-400";

export function PeoplePanel({
  people,
  roles,
  datasets,
  shared,
  canViewAs,
  manageMembership,
  initialRole,
}: {
  people: PersonRow[];
  roles: RoleRow[];
  datasets: DatasetRow[];
  /** Private dashboards shared with each person, by user id. */
  shared: Record<string, SharedDashboard[]>;
  canViewAs?: boolean;
  /** Offer Disable / Enable on each person. Only where this application owns
      sign-in: where an integration does, membership is decided there. */
  manageMembership?: boolean;
  /** Start filtered to one role — how Admin → Roles links to "who holds this". */
  initialRole?: string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [role, setRole] = useState(roles.some((r) => r.name === initialRole) ? (initialRole as string) : "");

  const needle = q.trim().toLowerCase();
  const matches = (name: string | null, email: string | null, held: string[]) =>
    (!needle || `${name ?? ""} ${email ?? ""}`.toLowerCase().includes(needle)) && (!role || held.includes(role));
  const shownPeople = people.filter((p) => matches(p.name, p.email, p.roles));
  const total = people.length;
  const shown = shownPeople.length;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className={`flex min-w-48 flex-1 flex-col gap-1 ${MUTED}`}>
          Find a person
          <input
            type="search"
            className={INPUT}
            placeholder="name or email"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <label className={`flex flex-col gap-1 ${MUTED}`}>
          Role
          <select className={INPUT} value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">All roles</option>
            {roles.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="overflow-x-auto rounded-md border border-gray-200 dark:border-gray-800">
        <div className="min-w-[40rem]">
          <div className={`${GRID} border-b border-gray-200 bg-gray-50 px-4 py-2 text-xs text-gray-600 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400`}>
            <span>Person</span>
            <span>Roles</span>
            <span>What they get</span>
            <span />
          </div>
          {shown === 0 && (
            <p className={`${MUTED} px-4 py-3`}>{total === 0 ? "Nobody yet." : "Nobody matches."}</p>
          )}
          {shownPeople.map((p) => {
            const isOpen = open === p.id;
            const access = resolveAccess(p.roles, datasets, { userId: p.id });
            return (
              <div
                key={p.id}
                className={`border-b border-gray-100 last:border-0 dark:border-gray-800 ${isOpen ? "bg-gray-50 dark:bg-gray-900/60" : ""}`}
              >
                <div className={`${GRID} items-center px-4 py-2.5`}>
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => setOpen(isOpen ? null : p.id)}
                    className="flex min-w-0 items-start gap-2 text-left"
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                      className={`mt-1 shrink-0 text-gray-500 transition-transform ${isOpen ? "rotate-90" : ""}`}
                    >
                      <path d="M9 6l6 6-6 6" />
                    </svg>
                    <span className="min-w-0">
                      {/* The name gives way before the tags do: "disabled" cut
                          to "disabl…" reads as a broken row, a long name cut
                          short still reads as a name. */}
                      <span className="flex min-w-0 items-baseline text-sm">
                        <span className="truncate">{personLabel(p)}</span>
                        {p.isSelf && <span className="ml-1 shrink-0 text-xs text-gray-500">(you)</span>}
                        {p.status === "disabled" && <span className={`ml-1.5 ${TAG}`}>disabled</span>}
                      </span>
                      {p.name && p.email && <span className={`block truncate ${MUTED}`}>{p.email}</span>}
                      {/* Added, and not arrived: a person all the same — the row
                          opens, their roles can be changed, they can be
                          impersonated to see what they will find. */}
                      {!p.signedIn && (
                        <>
                          <span className={`mt-0.5 inline-block ${TAG}`}>not signed in yet</span>
                          {p.added && (
                            <span className={`block ${MUTED}`}>
                              added {p.added.on}
                              {p.added.by ? ` by ${p.added.by}` : ""}
                            </span>
                          )}
                        </>
                      )}
                    </span>
                  </button>
                  <div className="flex flex-wrap gap-1">
                    {p.roles.length === 0 && <span className={MUTED}>no roles</span>}
                    {p.roles.map((r) => (
                      <RoleChip key={r} name={r} />
                    ))}
                  </div>
                  {p.isAdmin ? (
                    <AccessSummary access={access} datasets={datasets} admin />
                  ) : p.status === "disabled" ? (
                    // Their roles are untouched, and add up to nothing while they
                    // cannot sign in. Showing the sum would read as access.
                    <span className={MUTED}>Nothing: cannot sign in.</span>
                  ) : (
                    <AccessSummary access={access} datasets={datasets} />
                  )}
                  <div className="text-right">
                    {/* Nothing for an admin: they cannot be impersonated, and the
                        opened row says so. Three lines of grey here said it on
                        every admin's row, to someone who had not asked. */}
                    {canViewAs && !p.isAdmin && p.status === "active" ? (
                      <ViewAsButton userId={p.id} label={personLabel(p)} />
                    ) : null}
                  </div>
                </div>
                {isOpen && (
                  <div className="px-4 pb-4">
                    <PersonDetail
                      // Remounted when the stored roles change, so a save lands
                      // the panel back in its read state on what was saved.
                      key={p.roles.join(",")}
                      person={p}
                      roles={roles}
                      datasets={datasets}
                      shared={shared[p.id] ?? []}
                      manageMembership={manageMembership}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <p className={MUTED}>
        Open a row to see why someone gets what they get{manageMembership ? ", change their roles, or disable them" : " and change their roles"}.
        Changes take effect on their next request.
      </p>
    </section>
  );
}

/**
 * One person, opened: why they get what they get, and — after "Edit roles" —
 * the same table recomputed as roles are ticked, so the effect of a change is
 * read off the page before it is saved rather than worked out in the admin's
 * head.
 */
function PersonDetail({
  person,
  roles,
  datasets,
  shared,
  manageMembership,
}: {
  person: PersonRow;
  roles: RoleRow[];
  datasets: DatasetRow[];
  shared: SharedDashboard[];
  manageMembership?: boolean;
}) {
  const { run, busy, error } = useAction();
  const [editing, setEditing] = useState(false);
  const [picked, setPicked] = useState<string[]>(person.roles);

  const before = resolveAccess(person.roles, datasets, { userId: person.id });
  const now = resolveAccess(editing ? picked : person.roles, datasets, { userId: person.id });
  const wasOf = new Map(before.map((a) => [a.datasetId, a.level]));
  const nowOf = new Map(now.map((a) => [a.datasetId, a.level]));
  const titleOf = new Map(datasets.map((d) => [d.id, d.title]));
  const changedRoles = roles.filter((r) => picked.includes(r.name) !== person.roles.includes(r.name)).length;

  // Every dataset they reach, or that this edit touches. The rest are None and
  // would bury the ones that matter on an instance with many datasets.
  const rows = now.filter((a) => a.level !== "none" || wasOf.get(a.datasetId) !== "none");
  const untouched = now.length - rows.length;
  const changedDatasets = now.filter((a) => a.level !== wasOf.get(a.datasetId)).length;
  const name = person.name?.split(/\s+/)[0] ?? person.email ?? "this person";

  const toggle = (role: string, on: boolean) =>
    setPicked((p) => (on ? [...p, role] : p.filter((r) => r !== role)));

  return (
    <div className="flex flex-col gap-4 rounded-md border border-gray-300 bg-white p-4 dark:border-gray-700 dark:bg-gray-950">
      {/* Stacked, not side by side: the admin page is a narrow column, and the
          table is the thing that has to stay readable while roles are ticked. */}
      <div className="flex flex-col gap-4">
        {editing && (
          <div className="flex flex-col gap-1.5">
            <h4 className={HEADING}>Roles</h4>
            <div className="grid gap-1.5 sm:grid-cols-2">
            {roles.map((r) => {
              const on = picked.includes(r.name);
              const summary = describeRole(r.name, datasets);
              return (
                <label
                  key={r.name}
                  className={`flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2 ${
                    on ? "border-gray-900 bg-gray-50 dark:border-gray-100 dark:bg-gray-900" : "border-gray-200 dark:border-gray-800"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={on}
                    disabled={busy}
                    onChange={(e) => toggle(r.name, e.target.checked)}
                  />
                  <span className="min-w-0">
                    <span className="block break-all text-xs font-semibold">{r.name}</span>
                    <span className={`block ${MUTED}`}>{summary}</span>
                  </span>
                </label>
              );
            })}
            </div>
          </div>
        )}

        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h4 className={HEADING}>{editing ? `What ${name} will get` : `Why ${name} gets this`}</h4>
            <span className={MUTED}>When two roles name a dataset, the higher one wins.</span>
          </div>
          {person.isAdmin && !editing ? (
            <p className={MUTED}>
              An admin has Full on every dataset, whatever other roles they hold. Admins cannot be impersonated.
            </p>
          ) : rows.length === 0 ? (
            <p className={MUTED}>No role {editing ? "ticked" : "they hold"} opens a dataset.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-gray-200 dark:border-gray-800">
              <div className="min-w-[32rem]">
                <div className="grid grid-cols-[minmax(7rem,1fr)_6.5rem_minmax(8rem,1.4fr)_7.5rem] gap-3 border-b border-gray-200 bg-gray-50 px-3 py-1.5 text-xs text-gray-600 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
                  <span>Dataset</span>
                  <span>Gets</span>
                  <span>Because of</span>
                  <span>{editing ? "Change" : ""}</span>
                </div>
                {rows.map((a) => {
                  const was = wasOf.get(a.datasetId) ?? "none";
                  const differs = a.level !== was;
                  return (
                    <div
                      key={a.datasetId}
                      className={`grid grid-cols-[minmax(7rem,1fr)_6.5rem_minmax(8rem,1.4fr)_7.5rem] items-center gap-3 border-b border-gray-100 px-3 py-1.5 last:border-0 dark:border-gray-800 ${
                        differs ? "bg-amber-100 dark:bg-amber-950" : ""
                      }`}
                    >
                      <span className="text-xs">{titleOf.get(a.datasetId)}</span>
                      <span>
                        <LevelBadge level={a.level} />
                      </span>
                      <span className="break-all text-xs text-gray-700 dark:text-gray-300">
                        {a.level === "none" ? "no ticked role opens it" : a.because.join(", ")}
                      </span>
                      <span className="text-xs font-semibold">{differs ? `was ${LEVEL_LABEL[was]}` : ""}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {untouched > 0 && !person.isAdmin && (
            <p className={MUTED}>
              {untouched} other dataset{untouched === 1 ? "" : "s"}: None.
            </p>
          )}

          {shared.length > 0 && (
            <div className="flex flex-col gap-1 rounded-md bg-gray-100 px-3 py-2 dark:bg-gray-900">
              <span className={MUTED}>
                Private dashboards shared with {person.email ?? name}
                {editing ? " (not changed here)" : ""}:
              </span>
              {shared.map((s) => {
                // A share needs the dataset to be open to them at all. Saying
                // which ones this edit would strand is the reason to list them.
                const lost = (nowOf.get(s.datasetId) ?? "none") === "none" && !picked.includes(ADMIN);
                return (
                  <span key={`${s.datasetId}/${s.dashboard}`} className="text-xs">
                    {titleOf.get(s.datasetId) ?? "a dataset not listed here"} / {s.dashboard}
                    {lost && (
                      <span className="ml-2 font-semibold text-orange-900 dark:text-orange-300">
                        {editing ? "will stop seeing it" : "cannot see it"}: no role opens that dataset for them.
                      </span>
                    )}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {editing ? (
          <>
            <button
              type="button"
              disabled={busy || changedRoles === 0}
              onClick={() => void run({ action: "set-user-roles", userId: person.id, roles: picked })}
              className="rounded border border-gray-900 bg-gray-900 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50 dark:border-gray-100 dark:bg-gray-100 dark:text-gray-900"
            >
              Save roles
            </button>
            <button
              type="button"
              disabled={busy}
              className={BTN}
              onClick={() => {
                setPicked(person.roles);
                setEditing(false);
              }}
            >
              Cancel
            </button>
            <span className={MUTED}>
              {changedRoles === 0
                ? "No changes yet."
                : `${changedRoles} role${changedRoles === 1 ? "" : "s"} changed, ${changedDatasets} dataset${
                    changedDatasets === 1 ? "" : "s"
                  } affected.`}
            </span>
          </>
        ) : person.isOwner ? (
          <span className={MUTED}>The owner&rsquo;s roles cannot be changed here.</span>
        ) : (
          <button type="button" className={BTN} onClick={() => setEditing(true)}>
            Edit roles
          </button>
        )}
        {/* Whether they may sign in at all — beside the roles, because it is
            the other half of "what can this person reach". */}
        {manageMembership && !editing && !person.signedIn && (
          <RemoveAddedButton userId={person.id} label={personLabel(person)} />
        )}
        {manageMembership && !editing && person.signedIn && (
          <UserActions
            userId={person.id}
            status={person.status}
            role={person.isOwner ? "owner" : person.isAdmin ? "admin" : "member"}
            isSelf={person.isSelf}
            label={personLabel(person)}
          />
        )}
        {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
      </div>
    </div>
  );
}
