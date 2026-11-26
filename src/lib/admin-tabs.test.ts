// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The /admin tab set: the application's own tabs — Users, Datasets, Roles — and
// how an integration's contributed pages appear after them. The catch-all shell
// renders whatever page matches a slug; this module is what decides a slug's
// URL, so hostile slugs are pinned here too.
//
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { adminTabs } from "./admin-tabs.js";
import { hostedIntegration } from "./hosted-auth-integration.js";

const OWN = [
  { href: "/admin", label: "General", exact: true },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/datasets", label: "Datasets" },
  { href: "/admin/roles", label: "Roles" },
];

test("no integration: exactly the application's own tabs", () => {
  assert.deepEqual(adminTabs(null), OWN);
});

// Ties the seam's absent case to the surface: this build must not grow or lose admin
// tabs without somebody deciding to install an integration.
test("this build contributes no tabs", () => {
  assert.deepEqual(adminTabs(hostedIntegration()), adminTabs(null));
});

// An integration may supply the people, but which roles they hold is decided on
// the Users page and what a role opens on Roles — so none of the three goes
// away. (The Users PAGE drops its admission controls there; that is the page's
// concern, src/app/admin/users/page.tsx, not the tab set's.)
test("an integration's pages follow the application's own, all of which stay", () => {
  const tabs = adminTabs({
    adminPages: [
      { slug: "members", label: "Members", Component: () => null },
      { slug: "session", label: "Session", Component: () => null },
    ],
  });
  assert.deepEqual(tabs, [
    ...OWN,
    { href: "/admin/x/members", label: "Members" },
    { href: "/admin/x/session", label: "Session" },
  ]);
  assert.deepEqual(adminTabs({ adminPages: [] }), OWN);
});

// Slugs are the integration's, but the URL is ours: a slug that tries to path-traverse
// out of /admin/x/ must end up encoded into a single harmless segment.
test("a hostile slug cannot escape /admin/x/", () => {
  const tabs = adminTabs({
    adminPages: [{ slug: "../users?x=1", label: "Sneaky", Component: () => null }],
  });
  assert.equal(tabs.at(-1)?.href, "/admin/x/..%2Fusers%3Fx%3D1");
});
