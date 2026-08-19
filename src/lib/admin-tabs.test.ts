// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The /admin tab set: the application's own tabs, how an integration's contributed
// pages appear, and the one-people-surface rule — an integration that owns sign-in
// brings its own people page, so the application's Users tab leaves the nav. The
// catch-all shell renders whatever page matches a slug; this module is what decides a
// slug's URL, so hostile slugs are pinned here too.
//
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { adminTabs } from "./admin-tabs.js";
import { hostedIntegration } from "./hosted-auth-integration.js";

test("no integration: exactly the application's own tabs", () => {
  assert.deepEqual(adminTabs(null), [
    { href: "/admin", label: "General", exact: true },
    { href: "/admin/users", label: "Users" },
  ]);
});

// Ties the seam's absent case to the surface: this build must not grow or lose admin
// tabs without somebody deciding to install an integration.
test("this build contributes no tabs", () => {
  assert.deepEqual(adminTabs(hostedIntegration()), adminTabs(null));
});

test("an integration's pages follow General, and the Users tab yields to them", () => {
  const tabs = adminTabs({
    adminPages: [
      { slug: "members", label: "Members", Component: () => null },
      { slug: "session", label: "Session", Component: () => null },
    ],
  });
  assert.deepEqual(tabs, [
    { href: "/admin", label: "General", exact: true },
    { href: "/admin/x/members", label: "Members" },
    { href: "/admin/x/session", label: "Session" },
  ]);
});

// The rule keys on the integration existing, not on it contributing pages: membership
// lives with whoever owns sign-in even when nothing is contributed yet.
test("an integration with no pages still supplants the Users tab", () => {
  assert.deepEqual(adminTabs({ adminPages: [] }), [
    { href: "/admin", label: "General", exact: true },
  ]);
});

// Slugs are the integration's, but the URL is ours: a slug that tries to path-traverse
// out of /admin/x/ must end up encoded into a single harmless segment.
test("a hostile slug cannot escape /admin/x/", () => {
  const tabs = adminTabs({
    adminPages: [{ slug: "../users?x=1", label: "Sneaky", Component: () => null }],
  });
  assert.equal(tabs[1].href, "/admin/x/..%2Fusers%3Fx%3D1");
});
