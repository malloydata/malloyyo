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

  // Three pages, one question each: who may use the instance and what each of
  // them reaches (Users), what is published here and how its rows are scoped
  // (Datasets), and what each role opens (Roles). They were briefly ONE page,
  // seven sections long; nobody could find anything on it.
  //
  // All three stay when an integration owns sign-in. Membership lives with the
  // integration then, and the Users page leaves the admission controls out —
  // adding, approving, disabling — but who holds which role, and so which
  // datasets they open, is still this instance's decision, and that page is
  // where it is made.
  //
  // Before the contributed pages, so the application's own surface reads as one
  // group.
  tabs.push(
    { href: "/admin/users", label: "Users" },
    { href: "/admin/datasets", label: "Datasets" },
    { href: "/admin/roles", label: "Roles" },
  );

  for (const page of integration?.adminPages ?? []) {
    tabs.push({ href: `/admin/x/${encodeURIComponent(page.slug)}`, label: page.label });
  }
  return tabs;
}
