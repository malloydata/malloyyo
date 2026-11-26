// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Viewing as another user is LOOK-ONLY, and this is the rule that makes it so
// (src/lib/view-as.ts). `getSessionUser()` applies it to every request made
// while an admin is viewing as someone.

import test from "node:test";
import assert from "node:assert/strict";
import { proxyRefusesForViewAs, viewAsAllows } from "./view-as";

test("reads go ahead while viewing as someone", () => {
  for (const method of ["GET", "HEAD", "OPTIONS", "get"]) {
    assert.ok(viewAsAllows(method, "/datasets/sales/dashboard/overview"), method);
    assert.ok(viewAsAllows(method, "/api/dashboards"), method);
  }
});

test("running a query goes ahead, though it is asked for with a POST", () => {
  // Seeing what a person's queries return is how row scoping on a multi-tenant
  // dataset gets tested. Each of these routes is then responsible for leaving
  // no trace as that person.
  assert.ok(viewAsAllows("POST", "/api/dashboards/run"));
  assert.ok(viewAsAllows("POST", "/api/run"));
});

test("everything that would write as them is refused", () => {
  const writes: [string, string][] = [
    ["POST", "/api/ask"],
    ["POST", "/api/chats"],
    ["POST", "/api/tokens"], // would mint a credential that is theirs
    ["POST", "/api/oauth/authorize/decide"], // would consent on their behalf
    ["POST", "/api/favorites"],
    ["DELETE", "/api/datasets/sales/drafts/abc"],
    ["PATCH", "/api/dashboards/sales/overview/sharing"],
    ["POST", "/api/dashboards/run/"], // exact path only: no prefix games
    ["POST", "/api/dashboards/runaway"],
    ["POST", "/api/run/anything"],
    ["DELETE", "/api/run"], // the path alone is not the permission; a query run is a POST
  ];
  for (const [method, path] of writes) assert.ok(!viewAsAllows(method, path), `${method} ${path}`);
});

test("a request the proxy did not describe is refused", () => {
  // No method header means src/proxy.ts never saw the request. Treated as a
  // write to an unknown path rather than waved through.
  assert.ok(!viewAsAllows("", ""));
});

test("the proxy refuses a write only when a view-as cookie is present", () => {
  // No cookie: nothing to do with view-as, whatever the request.
  assert.ok(!proxyRefusesForViewAs(false, "POST", "/api/tokens"));
  // Cookie present: writes are refused with a sentence that says why, before
  // a route can turn the same refusal into "sign in required".
  assert.ok(proxyRefusesForViewAs(true, "POST", "/api/tokens"));
  assert.ok(proxyRefusesForViewAs(true, "POST", "/api/oauth/authorize/decide"), "no consenting on their behalf");
  assert.ok(proxyRefusesForViewAs(true, "PATCH", "/api/dashboards/sales/overview/sharing"));
  // …reads and query runs are not…
  assert.ok(!proxyRefusesForViewAs(true, "GET", "/api/tokens"));
  assert.ok(!proxyRefusesForViewAs(true, "POST", "/api/run"));
  assert.ok(!proxyRefusesForViewAs(true, "POST", "/api/dashboards/run"));
});

test("the way out is never refused", () => {
  // Stopping, starting on someone else, signing out, and the page-view beacon:
  // none of them acts as the person being viewed.
  assert.ok(!proxyRefusesForViewAs(true, "DELETE", "/api/admin/view-as"));
  assert.ok(!proxyRefusesForViewAs(true, "POST", "/api/admin/view-as"));
  assert.ok(!proxyRefusesForViewAs(true, "POST", "/api/auth/signout"));
  assert.ok(!proxyRefusesForViewAs(true, "POST", "/api/telemetry/page"));
  // An exact path stays exact: nothing rides in on its name.
  assert.ok(proxyRefusesForViewAs(true, "POST", "/api/admin/view-as-if"));
  assert.ok(proxyRefusesForViewAs(true, "POST", "/api/admin/roles"));
});
