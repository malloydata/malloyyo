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

  // One people surface per deployment. With no integration, the application's users
  // list is the admin's people page. When an integration owns sign-in, membership lives
  // with it — the pages it contributes include its own people surface — and a second
  // people-shaped tab beside that one reads as a competing roster rather than what it
  // is: the application's local records. The /admin/users route stays reachable; it
  // just stops presenting as a peer.
  if (integration === null) {
    tabs.push({ href: "/admin/users", label: "Users" });
  }

  // Roles stays whoever owns sign-in. An integration may supply the PEOPLE, but
  // which datasets those people may open is this instance's decision, so this
  // tab does not yield the way Users does. Before the contributed pages, so the
  // application's own surface reads as one group.
  tabs.push({ href: "/admin/roles", label: "Roles" });

  for (const page of integration?.adminPages ?? []) {
    tabs.push({ href: `/admin/x/${encodeURIComponent(page.slug)}`, label: page.label });
  }
  return tabs;
}
