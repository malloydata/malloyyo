// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";

// The two working surfaces of Admin → Users & roles.
//
//   RolesPanel   pick a role; set what it gets on each dataset — None,
//                Dashboards, Full — one switch per dataset.
//   PeoplePanel  each person, the roles they hold, and WHAT THAT ADDS UP TO.
//                A row opens to show why, and to edit the roles with the
//                result previewed before anything is saved.
//
// The arithmetic both show is src/lib/role-access.ts: the same rule the server
// enforces in SQL, written out so this page can show its working. Nothing here
// decides access — every write goes to /api/admin/roles, which re-checks it.

import { useState } from "react";
import {
  LEVEL_LABEL,
  resolveAccess,
  roleLevelOn,
  type DatasetGrants,
  type ResolvedAccess,
  type RoleLevel,
} from "@/lib/role-access";
import { ViewAsButton } from "@/components/ViewAsButton";
import { UserActions } from "../users/roster-controls";
import { BTN, DeleteRoleButton, NewRoleForm, useAction } from "./role-controls";

const ADMIN = "MALLOYYO_ADMIN";

export interface RoleRow {
  name: string;
  description: string | null;
  builtin: boolean;
}

export interface DatasetRow extends DatasetGrants {
  /** The dataset's name: its identity, shown under the title because titles are
      not unique and this page is where access is decided. */
  name: string;
  title: string;
}

export interface PersonRow {
  id: string;
  name: string | null;
  email: string | null;
  /** Every role they hold, the way the server reads it (`rolesOf`). */
  roles: string[];
  isAdmin: boolean;
  /** The instance owner, whose roles this page cannot change. */
  isOwner: boolean;
  isSelf: boolean;
  /** Whether they may sign in at all. A disabled person keeps their roles —
      enabling them gives back exactly what they had — but reaches nothing. */
  status: "active" | "disabled";
}

/** A private dashboard shared with one person by email. */
export interface SharedDashboard {
  datasetId: string;
  dashboard: string;
}

const LEVELS: RoleLevel[] = ["none", "view", "query"];
const HEADING = "text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400";
const MUTED = "text-xs text-gray-600 dark:text-gray-400";

const BADGE: Record<RoleLevel, string> = {
  none: "bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-gray-100",
  view: "bg-blue-700 text-white",
  query: "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900",
};

function LevelBadge({ level }: { level: RoleLevel }) {
  return <span className={`inline-block rounded px-2 py-0.5 text-xs ${BADGE[level]}`}>{LEVEL_LABEL[level]}</span>;
}

const personLabel = (p: Pick<PersonRow, "name" | "email" | "id">) => p.name ?? p.email ?? p.id.slice(0, 8);

// ── Roles ────────────────────────────────────────────────────────────────────

/**
 * One role's level on one dataset. Saved on click — it is one choice among
 * three, and a Save button beside a switch is a second click that can only be
 * forgotten. Shown at once and put back if the server refuses.
 *
 * The parent keys this on the stored level, so a refresh that changes it
 * remounts the switch on the new value instead of leaving the old one showing.
 */
function LevelSwitch({ role, dataset, level }: { role: string; dataset: DatasetRow; level: RoleLevel }) {
  const { run, busy, error } = useAction();
  const [shown, setShown] = useState<RoleLevel>(level);
  const set = async (next: RoleLevel) => {
    if (next === shown) return;
    const before = shown;
    setShown(next);
    if (!(await run({ action: "set-level", name: role, datasetId: dataset.id, level: next }))) setShown(before);
  };
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <span
        role="group"
        aria-label={`What ${role} gets on ${dataset.title}`}
        className="inline-flex overflow-hidden rounded-md border border-gray-400 dark:border-gray-600"
      >
        {LEVELS.map((l, i) => (
          <button
            key={l}
            type="button"
            disabled={busy}
            aria-pressed={shown === l}
            onClick={() => void set(l)}
            className={`min-h-9 px-3 text-xs disabled:opacity-60 ${i > 0 ? "border-l border-gray-400 dark:border-gray-600" : ""} ${
              shown === l
                ? `font-semibold ${BADGE[l]}`
                : "bg-white text-gray-700 hover:bg-gray-50 dark:bg-gray-950 dark:text-gray-300 dark:hover:bg-gray-900"
            }`}
          >
            {LEVEL_LABEL[l]}
          </button>
        ))}
      </span>
      {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
    </span>
  );
}

function roleSummary(role: RoleRow, datasets: DatasetRow[], holders: number): string {
  const full = datasets.filter((d) => roleLevelOn(d, role.name) === "query").length;
  const dash = datasets.filter((d) => roleLevelOn(d, role.name) === "view").length;
  const parts = [
    ...(role.builtin ? ["built in"] : []),
    ...(full ? [`${full} full`] : []),
    ...(dash ? [`${dash} dashboards`] : []),
    ...(!full && !dash ? ["no datasets"] : []),
  ];
  return `${parts.join(", ")} · ${holders} ${holders === 1 ? "person" : "people"}`;
}

export function RolesPanel({
  roles,
  datasets,
  people,
  canViewAs,
}: {
  roles: RoleRow[];
  datasets: DatasetRow[];
  people: PersonRow[];
  /** Offer "View as" beside each person. */
  canViewAs?: boolean;
}) {
  // MALLOYYO_ADMIN is not a role to configure: it is full on everything, by
  // rule. It gets a line saying so instead of a row of switches that would not
  // do anything.
  const editable = roles.filter((r) => r.name !== ADMIN);
  const [picked, setPicked] = useState<string | null>(null);
  const role = editable.find((r) => r.name === picked) ?? editable[0];
  const holdersOf = (name: string) => people.filter((p) => p.roles.includes(name));

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-medium">Roles</h2>
        <p className={`${MUTED} mt-1 max-w-2xl`}>
          A role sets what its people get on each dataset. <strong>None</strong>: the dataset is not there.{" "}
          <strong>Dashboards</strong>: open its dashboards, nothing else. <strong>Full</strong>: dashboards, plus
          query, chat and the Claude connector. Someone with several roles gets the most any of them gives on
          each dataset.
        </p>
      </div>

      <NewRoleForm />

      <div className="flex flex-wrap items-start gap-6">
        <div className="flex w-full flex-col gap-2 sm:w-64">
          {editable.map((r) => {
            const selected = r.name === role?.name;
            return (
              <button
                key={r.name}
                type="button"
                aria-pressed={selected}
                onClick={() => setPicked(r.name)}
                className={`flex flex-col gap-0.5 rounded-md border px-3 py-2 text-left ${
                  selected
                    ? "border-gray-900 bg-gray-900 text-white dark:border-gray-100 dark:bg-gray-100 dark:text-gray-900"
                    : "border-gray-200 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900"
                }`}
              >
                <span className="break-all text-xs font-semibold">{r.name}</span>
                <span className={`text-xs ${selected ? "opacity-80" : "text-gray-600 dark:text-gray-400"}`}>
                  {roleSummary(r, datasets, holdersOf(r.name).length)}
                </span>
              </button>
            );
          })}
          <div className="flex flex-col gap-0.5 rounded-md border border-dashed border-gray-300 px-3 py-2 dark:border-gray-700">
            <span className="text-xs font-semibold">{ADMIN}</span>
            <span className={MUTED}>Built in. Full on every dataset, always.</span>
          </div>
        </div>

        {role ? (
          <RoleDetail
            // Remounted per role, so nothing typed or pending carries over.
            key={role.name}
            role={role}
            datasets={datasets}
            holders={holdersOf(role.name)}
            canViewAs={canViewAs}
          />
        ) : null}
      </div>
    </section>
  );
}

function RoleDetail({
  role,
  datasets,
  holders,
  canViewAs,
}: {
  role: RoleRow;
  datasets: DatasetRow[];
  holders: PersonRow[];
  canViewAs?: boolean;
}) {
  const levels = datasets.map((d) => roleLevelOn(d, role.name));
  const full = levels.filter((l) => l === "query").length;
  const dash = levels.filter((l) => l === "view").length;
  const summary =
    full === 0 && dash > 0
      ? "Someone who holds only this role sees dashboards and nothing else: no query editor, no chat, no connector."
      : full === 0
        ? "This role opens nothing yet."
        : `People in this role can query ${full} dataset${full === 1 ? "" : "s"}${
            dash ? ` and read dashboards on ${dash} more.` : "."
          }`;
  const SHOWN = 8;

  return (
    <div className="flex min-w-0 flex-1 basis-96 flex-col gap-5 rounded-lg border border-gray-200 p-5 dark:border-gray-800">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-all text-base font-bold">{role.name}</h3>
          {role.description && <p className={`${MUTED} mt-0.5 max-w-xl`}>{role.description}</p>}
        </div>
        {role.builtin ? (
          <span className="rounded-full border border-gray-300 px-2.5 py-0.5 text-xs text-gray-700 dark:border-gray-700 dark:text-gray-300">
            built in
          </span>
        ) : (
          <DeleteRoleButton name={role.name} holders={holders.length} />
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h4 className={HEADING}>What this role gets on each dataset</h4>
        {datasets.length === 0 ? (
          <p className={MUTED}>No datasets yet.</p>
        ) : (
          <div className="overflow-hidden rounded-md border border-gray-200 dark:border-gray-800">
            {datasets.map((d) => {
              const level = roleLevelOn(d, role.name);
              return (
                <div
                  key={d.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-3 py-2 last:border-0 dark:border-gray-800"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-semibold">{d.title}</div>
                    <div className={MUTED}>{d.name}</div>
                  </div>
                  <LevelSwitch key={level} role={role.name} dataset={d} level={level} />
                </div>
              );
            })}
          </div>
        )}
        <p className={MUTED}>{summary}</p>
        <p className={MUTED}>
          Dashboards and Full both show every public dashboard on the dataset. A private dashboard is shared by
          email address from its own page, never through a role.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <h4 className={HEADING}>People in this role ({holders.length})</h4>
        {holders.length === 0 ? (
          <p className={MUTED}>Nobody yet. Give it to someone under People, below.</p>
        ) : (
          <div className="overflow-hidden rounded-md border border-gray-200 dark:border-gray-800">
            {holders.slice(0, SHOWN).map((p) => (
              <div
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-3 py-1.5 last:border-0 dark:border-gray-800"
              >
                <div className="min-w-0">
                  <div className="text-sm">{personLabel(p)}</div>
                  {p.name && p.email && <div className={MUTED}>{p.email}</div>}
                </div>
                {canViewAs && !p.isAdmin && p.status === "active" && (
                  <ViewAsButton userId={p.id} label={personLabel(p)} />
                )}
              </div>
            ))}
          </div>
        )}
        {holders.length > SHOWN && <p className={MUTED}>and {holders.length - SHOWN} more</p>}
      </div>
    </div>
  );
}

// ── People ───────────────────────────────────────────────────────────────────

/** "Full: Sales, Finance" / "Dashboards: Support" — one person's access, said
    in a line each. */
function AccessSummary({ access, datasets }: { access: ResolvedAccess[]; datasets: DatasetRow[] }) {
  const titleOf = new Map(datasets.map((d) => [d.id, d.title]));
  const at = (level: RoleLevel) =>
    access.filter((a) => a.level === level).map((a) => titleOf.get(a.datasetId) ?? a.datasetId);
  const full = at("query");
  const dash = at("view");
  if (full.length === 0 && dash.length === 0) {
    return <span className={MUTED}>Nothing yet. They sign in to an empty page.</span>;
  }
  return (
    <div className="flex flex-col gap-1">
      {full.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <LevelBadge level="query" />
          <span className="text-xs">{full.join(", ")}</span>
        </div>
      )}
      {dash.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <LevelBadge level="view" />
          <span className="text-xs">{dash.join(", ")}</span>
        </div>
      )}
    </div>
  );
}

export function PeoplePanel({
  people,
  roles,
  datasets,
  shared,
  canViewAs,
  manageMembership,
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
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-medium">People</h2>
        <p className={`${MUTED} mt-1 max-w-2xl`}>
          Each person holds one or more roles. &ldquo;What they get&rdquo; is the result, worked out for you.
          Open a row to see why, and to change their roles. Changes take effect on their next request.
        </p>
      </div>
      <div className="overflow-x-auto rounded-md border border-gray-200 dark:border-gray-800">
        <div className="min-w-[40rem]">
          <div className="grid grid-cols-[11.5rem_10rem_minmax(0,1fr)_5.5rem] gap-4 border-b border-gray-200 bg-gray-50 px-4 py-2 text-xs text-gray-600 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
            <span>Person</span>
            <span>Roles</span>
            <span>What they get</span>
            <span />
          </div>
          {people.map((p) => {
            const isOpen = open === p.id;
            const access = resolveAccess(p.roles, datasets, { userId: p.id });
            return (
              <div
                key={p.id}
                className={`border-b border-gray-100 last:border-0 dark:border-gray-800 ${isOpen ? "bg-gray-50 dark:bg-gray-900/60" : ""}`}
              >
                <div className="grid grid-cols-[11.5rem_10rem_minmax(0,1fr)_5.5rem] items-center gap-4 px-4 py-2.5">
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
                        {p.status === "disabled" && (
                          <span className="ml-1.5 shrink-0 rounded border border-gray-400 px-1 text-xs text-gray-600 dark:border-gray-600 dark:text-gray-400">
                            disabled
                          </span>
                        )}
                      </span>
                      {p.name && p.email && <span className={`block truncate ${MUTED}`}>{p.email}</span>}
                    </span>
                  </button>
                  <div className="flex flex-wrap gap-1">
                    {p.roles.length === 0 && <span className={MUTED}>no roles</span>}
                    {p.roles.map((r) => (
                      <span
                        key={r}
                        className={`break-all rounded-full border px-2 py-0.5 text-xs ${
                          r === ADMIN ? "border-gray-900 dark:border-gray-100" : "border-gray-300 dark:border-gray-700"
                        }`}
                      >
                        {r}
                      </span>
                    ))}
                  </div>
                  {p.isAdmin ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <LevelBadge level="query" />
                      <span className="text-xs">Every dataset, and this admin panel</span>
                    </div>
                  ) : p.status === "disabled" ? (
                    // Their roles are untouched, and add up to nothing while they
                    // cannot sign in. Showing the sum would read as access.
                    <span className={MUTED}>Nothing: cannot sign in.</span>
                  ) : (
                    <AccessSummary access={access} datasets={datasets} />
                  )}
                  <div className="text-right">
                    {p.isAdmin ? (
                      canViewAs ? <span className={MUTED}>admins cannot be viewed as</span> : null
                    ) : canViewAs && p.status === "active" ? (
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
              const summary =
                r.name === ADMIN
                  ? "Built in. Full on everything, plus this admin panel."
                  : describeRole(r.name, datasets);
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
            <p className={MUTED}>An admin has Full on every dataset, whatever other roles they hold.</p>
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
        {manageMembership && !editing && (
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

/** "Full: Sales, Finance. Dashboards: Support." — what one role opens. */
function describeRole(role: string, datasets: DatasetRow[]): string {
  const at = (level: RoleLevel) => datasets.filter((d) => roleLevelOn(d, role) === level).map((d) => d.title);
  const full = at("query");
  const dash = at("view");
  const parts = [
    ...(full.length ? [`Full: ${full.join(", ")}`] : []),
    ...(dash.length ? [`Dashboards: ${dash.join(", ")}`] : []),
  ];
  return parts.length ? `${parts.join(". ")}.` : "Opens nothing.";
}
