// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// What Admin → Users, Admin → Datasets and Admin → Roles say in common: the
// row shapes the three pages pass around, and the few pieces that have to read
// the same on all of them — a level's badge, a person's label, one role or one
// person's access said in a line.
//
// No "use client": nothing here holds state, so the server-rendered Datasets
// page and the two client workspaces can all import it.
//
// The arithmetic is src/lib/role-access.ts: the same rule the server enforces
// in SQL, written out so these pages can show their working. Nothing here
// decides access.

import {
  LEVEL_LABEL,
  roleLevelOn,
  type DatasetGrants,
  type ResolvedAccess,
  type RoleLevel,
} from "@/lib/role-access";

export const ADMIN = "MALLOYYO_ADMIN";

export interface RoleRow {
  name: string;
  description: string | null;
  builtin: boolean;
}

export interface DatasetRow extends DatasetGrants {
  /** The dataset's name: its identity, shown under the title because titles are
      not unique and these pages are where access is decided. */
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
  /** The instance owner, whose roles these pages cannot change. */
  isOwner: boolean;
  isSelf: boolean;
  /** Whether they may sign in at all. A disabled person keeps their roles —
      enabling them gives back exactly what they had — but reaches nothing. */
  status: "active" | "disabled";
}

/** Someone added by address who has not signed in yet. */
export interface InvitedRow {
  id: string;
  email: string;
  /** What they will hold when they arrive. */
  roles: string[];
  /** YYYY-MM-DD. */
  addedOn: string;
  /** Who added them, when that is still known. */
  addedBy: string | null;
}

/** A private dashboard shared with one person by email. */
export interface SharedDashboard {
  datasetId: string;
  dashboard: string;
}

export const LEVELS: RoleLevel[] = ["none", "view", "query"];
export const HEADING = "text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400";
export const MUTED = "text-xs text-gray-600 dark:text-gray-400";
export const PRIMARY =
  "rounded bg-black px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40 dark:bg-white dark:text-black";

export const BADGE: Record<RoleLevel, string> = {
  none: "bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-gray-100",
  view: "bg-blue-700 text-white",
  query: "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900",
};

export function LevelBadge({ level }: { level: RoleLevel }) {
  return <span className={`inline-block rounded px-2 py-0.5 text-xs ${BADGE[level]}`}>{LEVEL_LABEL[level]}</span>;
}

export const personLabel = (p: Pick<PersonRow, "name" | "email" | "id">) => p.name ?? p.email ?? p.id.slice(0, 8);

/** One role as a chip. The admin role is outlined harder: it is the one that
    changes what every other chip on the row means. */
export function RoleChip({ name }: { name: string }) {
  return (
    <span
      className={`break-all rounded-full border px-2 py-0.5 text-xs ${
        name === ADMIN ? "border-gray-900 dark:border-gray-100" : "border-gray-300 dark:border-gray-700"
      }`}
    >
      {name}
    </span>
  );
}

/** "Full: Sales, Finance. Dashboards: Support." — what one role opens. */
export function describeRole(role: string, datasets: DatasetRow[]): string {
  if (role === ADMIN) return "Built in. Full on everything, plus this admin panel.";
  const at = (level: RoleLevel) => datasets.filter((d) => roleLevelOn(d, role) === level).map((d) => d.title);
  const full = at("query");
  const dash = at("view");
  const parts = [
    ...(full.length ? [`Full: ${full.join(", ")}`] : []),
    ...(dash.length ? [`Dashboards: ${dash.join(", ")}`] : []),
  ];
  return parts.length ? `${parts.join(". ")}.` : "Opens nothing.";
}

/** "Full: Sales, Finance" / "Dashboards: Support" — one person's access, said
    in a line each. */
export function AccessSummary({
  access,
  datasets,
  admin,
}: {
  access: ResolvedAccess[];
  datasets: DatasetRow[];
  /** Holds the admin role: every dataset, and nothing to list. */
  admin?: boolean;
}) {
  if (admin) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <LevelBadge level="query" />
        <span className="text-xs">Every dataset, and this admin panel</span>
      </div>
    );
  }
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
