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

import type { ReactNode } from "react";
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

// A LEVEL IS AN AMOUNT, SO IT IS DRAWN AS ONE: more access, more ink. Full is
// solid, Dashboards is the same shape left hollow, None is a dashed outline.
//
// Dashboards used to be blue. Blue said nothing — there is no sense in which
// dashboards-only is "blue" — and as the only colour on these pages it drew the
// eye to the LESSER level first, and read as a link besides. Hue is kept for
// things that are states (the amber of someone waiting, the red of an error).
export const BADGE: Record<RoleLevel, string> = {
  none: "border border-dashed border-gray-400 text-gray-600 dark:border-gray-600 dark:text-gray-400",
  view: "border border-gray-900 text-gray-900 dark:border-gray-100 dark:text-gray-100",
  query: "border border-gray-900 bg-gray-900 text-white dark:border-gray-100 dark:bg-gray-100 dark:text-gray-900",
};

export function LevelBadge({ level, block }: { level: RoleLevel; block?: boolean }) {
  return (
    <span className={`rounded px-2 py-0.5 text-xs ${block ? "block text-center" : "inline-block"} ${BADGE[level]}`}>
      {LEVEL_LABEL[level]}
    </span>
  );
}

/**
 * "Full — these. Dashboards — those." One row per level: the level in a column
 * of its own, what it covers beside it.
 *
 * The two used to be a badge followed by text in one wrapping line, and nothing
 * tied a list to its badge: a long list wrapped UNDER the badge, which then
 * read as a heading, while a short one sat beside it and read as a prefix — two
 * shapes for one thing, in adjacent rows. Here the labels are one column of
 * equal-width boxes and every list starts on the same edge and wraps inside its
 * own column, so which names belong to which level is a matter of alignment
 * rather than of reading closely.
 */
export function LevelRows({ rows }: { rows: { level: RoleLevel; text: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-[5.75rem_minmax(0,1fr)] items-start gap-x-2.5 gap-y-1.5">
      {rows.map((r) => (
        <div key={r.level} className="contents">
          <dt>
            <LevelBadge level={r.level} block />
          </dt>
          {/* The same line box as the badge, so a one-line list sits level with it. */}
          <dd className="break-words border border-transparent py-0.5 text-xs">{r.text}</dd>
        </div>
      ))}
    </dl>
  );
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
  if (admin) return <LevelRows rows={[{ level: "query", text: "Every dataset, and this admin panel" }]} />;
  const titleOf = new Map(datasets.map((d) => [d.id, d.title]));
  const at = (level: RoleLevel) =>
    access.filter((a) => a.level === level).map((a) => titleOf.get(a.datasetId) ?? a.datasetId);
  const full = at("query");
  const dash = at("view");
  if (full.length === 0 && dash.length === 0) {
    return <span className={MUTED}>Nothing yet. They sign in to an empty page.</span>;
  }
  return (
    <LevelRows
      rows={[
        ...(full.length > 0 ? [{ level: "query" as const, text: full.join(", ") }] : []),
        ...(dash.length > 0 ? [{ level: "view" as const, text: dash.join(", ") }] : []),
      ]}
    />
  );
}
