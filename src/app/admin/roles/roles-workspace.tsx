// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";

// Admin → Roles: pick a role; set what it gets on each dataset — None,
// Dashboards, Full — one switch per dataset; and say whether new users are
// given it.
//
// Who holds a role is Admin → Users, and what a dataset is scoped by is
// Admin → Datasets. This page is only the roles.
//
// The arithmetic is src/lib/role-access.ts: the same rule the server enforces
// in SQL. Nothing here decides access — every write goes to /api/admin/roles,
// which re-checks it.

import { useState } from "react";
import Link from "next/link";
import { LEVEL_LABEL, roleLevelOn, type RoleLevel } from "@/lib/role-access";
import {
  ADMIN,
  HEADING,
  LEVELS,
  MUTED,
  personLabel,
  PRIMARY,
  type DatasetRow,
  type PersonRow,
  type RoleRow,
} from "../access-shared";
import { DeleteRoleButton, NewRoleForm, useAction } from "./role-controls";

/**
 * One role's level on one dataset. Saved on click — it is one choice among
 * three, and a Save button beside a switch is a second click that can only be
 * forgotten. Shown at once and put back if the server refuses.
 *
 * The parent keys this on the stored level, so a refresh that changes it
 * remounts the switch on the new value instead of leaving the old one showing.
 */
// The chosen segment of a level switch. Position says WHICH level; the fill only
// says "this one". So Dashboards and Full are chosen in the same ink — one being
// blue made it look like a different kind of thing — and None, which is the
// absence of a grant, is chosen quietly.
const PICKED: Record<RoleLevel, string> = {
  none: "bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-gray-100",
  view: "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900",
  query: "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900",
};

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
                ? `font-semibold ${PICKED[l]}`
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

function roleSummary(role: RoleRow, datasets: DatasetRow[], holders: number, isDefault: boolean): string {
  const full = datasets.filter((d) => roleLevelOn(d, role.name) === "query").length;
  const dash = datasets.filter((d) => roleLevelOn(d, role.name) === "view").length;
  const parts = [
    ...(role.builtin ? ["built in"] : []),
    ...(full ? [`${full} full`] : []),
    ...(dash ? [`${dash} dashboards`] : []),
    ...(!full && !dash && !role.builtin ? ["no datasets"] : []),
    `${holders} ${holders === 1 ? "person" : "people"}`,
    ...(isDefault ? ["given to new users"] : []),
  ];
  return parts.join(" · ");
}

export function RolesPanel({
  roles,
  datasets,
  people,
  defaults,
  neverDefault,
}: {
  roles: RoleRow[];
  datasets: DatasetRow[];
  people: PersonRow[];
  /** The roles a new user is given. */
  defaults: string[];
  /** Roles that may never be given automatically (the server refuses them). */
  neverDefault: readonly string[];
}) {
  // MALLOYYO_ADMIN is not a role to configure: it is full on everything, by
  // rule. It gets a line saying so instead of a row of switches that would not
  // do anything.
  const editable = roles.filter((r) => r.name !== ADMIN);
  const [picked, setPicked] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const role = editable.find((r) => r.name === picked) ?? editable[0];
  const holdersOf = (name: string) => people.filter((p) => p.roles.includes(name));
  const yours = roles.filter((r) => !r.builtin).length;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2.5">
          <h2 className="text-base font-semibold">Roles</h2>
          <span className={MUTED}>
            {yours} of yours, {roles.length - yours} built in
          </span>
        </div>
        {!adding && (
          <button type="button" className={PRIMARY} onClick={() => setAdding(true)}>
            Add role
          </button>
        )}
      </div>

      {adding && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-gray-200 p-3 dark:border-gray-800">
          <div className="min-w-0 flex-1">
            <NewRoleForm onDone={() => setAdding(false)} />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-start gap-4">
        <div className="flex w-full flex-col gap-1.5 sm:w-56">
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
                  {roleSummary(r, datasets, holdersOf(r.name).length, defaults.includes(r.name))}
                </span>
              </button>
            );
          })}
          <div className="flex flex-col gap-0.5 rounded-md border border-dashed border-gray-300 px-3 py-2 dark:border-gray-700">
            <span className="text-xs font-semibold">{ADMIN}</span>
            <span className={MUTED}>built in · full on every dataset</span>
          </div>
        </div>

        {role ? (
          <RoleDetail
            // Remounted per role, so nothing typed or pending carries over.
            key={role.name}
            role={role}
            datasets={datasets}
            holders={holdersOf(role.name)}
            defaults={defaults}
            mayBeDefault={!neverDefault.includes(role.name)}
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
  defaults,
  mayBeDefault,
}: {
  role: RoleRow;
  datasets: DatasetRow[];
  holders: PersonRow[];
  defaults: string[];
  mayBeDefault: boolean;
}) {
  const SHOWN = 6;
  return (
    <div className="flex min-w-0 flex-1 basis-80 flex-col gap-5 rounded-lg border border-gray-200 p-5 dark:border-gray-800">
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
                    <div className="text-sm">{d.title}</div>
                    <div className={MUTED}>{d.name}</div>
                  </div>
                  <LevelSwitch key={level} role={role.name} dataset={d} level={level} />
                </div>
              );
            })}
          </div>
        )}
        <p className={MUTED}>
          Dashboards: open the dashboards, nothing else. Full: dashboards plus query, chat and the Claude connector.
          Someone with several roles gets the most any of them gives.
        </p>
      </div>

      {mayBeDefault && (
        // Keyed on what is stored, like the level switches: a refresh that
        // changes it remounts the box on the new value.
        <DefaultToggle key={String(defaults.includes(role.name))} role={role.name} defaults={defaults} />
      )}

      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className={MUTED}>
          {holders.length === 0 ? (
            "Held by nobody yet."
          ) : (
            <>
              Held by {holders.length} {holders.length === 1 ? "person" : "people"}:{" "}
              <span className="text-gray-900 dark:text-gray-100">
                {holders.slice(0, SHOWN).map(personLabel).join(", ")}
              </span>
              {holders.length > SHOWN ? ` and ${holders.length - SHOWN} more` : ""}
            </>
          )}
        </span>
        <Link href={`/admin/users?role=${encodeURIComponent(role.name)}`} className="text-xs underline">
          {holders.length === 0 ? "Give it to someone on Users" : "Show them on Users"}
        </Link>
      </div>
    </div>
  );
}

/**
 * Whether new users are given this role. One tick per role, where the role is —
 * the list of all of them used to be a section of its own.
 *
 * The instance always gives new users SOMETHING (src/lib/roles.ts falls back to
 * MALLOYYO_USER when the list is empty), so the last ticked role cannot be
 * unticked: it would save, and come back ticked.
 */
function DefaultToggle({ role, defaults }: { role: string; defaults: string[] }) {
  const { run, busy, error } = useAction();
  const stored = defaults.includes(role);
  // Shown at once and put back if the server refuses, as a level is.
  const [on, setOn] = useState(stored);
  const onlyOne = stored && defaults.length === 1;
  const set = async (next: boolean) => {
    setOn(next);
    const roles = next ? [...defaults, role] : defaults.filter((r) => r !== role);
    if (!(await run({ action: "set-default", roles }))) setOn(stored);
  };
  return (
    <div className="flex flex-col gap-1">
      <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-gray-200 px-3 py-2.5 dark:border-gray-800">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={on}
          disabled={busy || onlyOne}
          onChange={(e) => void set(e.target.checked)}
        />
        <span className="min-w-0">
          <span className="block text-sm">Give this role to new users</span>
          <span className={`block ${MUTED}`}>
            {onlyOne
              ? "The only role new users are given. Tick it on another role first to take it off this one."
              : "Ticked for them when you add someone, and given to anyone you approve."}
          </span>
        </span>
      </label>
      {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
    </div>
  );
}
