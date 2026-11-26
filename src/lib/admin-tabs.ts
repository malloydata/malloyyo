// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The tab set for the /admin layout: the application's own pages, then one entry per
// admin page the build's integration contributes (src/lib/hosted-auth.ts). Pure and
// import-light on purpose — the unit suite has no database, and this is the part of the
// admin surface it can pin.

import type { HostedAuthIntegration } from "./hosted-auth";

export type AdminTab = {
  href: string;
  label: string;
  /** Highlight only on an exact path match — for /admin itself, a prefix of everything. */
  exact?: boolean;
};

export function adminTabs(
  integration: Pick<HostedAuthIntegration, "adminPages"> | null,
): AdminTab[] {
  const tabs: AdminTab[] = [{ href: "/admin", label: "General", exact: true }];

  // People and roles are ONE page (src/app/admin/roles): who may use the
  // instance, what each of them can reach, and what each role opens. It used to
  // be two tabs that listed the same people twice.
  //
  // What it is CALLED depends on who owns sign-in. With no integration, the
  // application's own roster is on it — approve, invite, disable — so it is the
  // admin's people page and says so. When an integration owns sign-in,
  // membership lives with it, the pages it contributes include its own people
  // surface, and this page leaves the roster controls out; a tab named "Users"
  // beside that one would read as a competing roster. There it is "Roles":
  // which datasets those people may open is still this instance's decision.
  //
  // Before the contributed pages, so the application's own surface reads as one
  // group. /admin/users still resolves — it redirects here.
  tabs.push({ href: "/admin/roles", label: integration === null ? "Users & roles" : "Roles" });

  for (const page of integration?.adminPages ?? []) {
    tabs.push({ href: `/admin/x/${encodeURIComponent(page.slug)}`, label: page.label });
  }
  return tabs;
}
