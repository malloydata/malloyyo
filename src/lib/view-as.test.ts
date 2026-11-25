// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Viewing as another user is LOOK-ONLY, and this is the rule that makes it so
// (src/lib/view-as.ts). `getSessionUser()` applies it to every request made
// while an admin is viewing as someone.

import test from "node:test";
import assert from "node:assert/strict";
import { viewAsAllows } from "./view-as";

test("reads go ahead while viewing as someone", () => {
  for (const method of ["GET", "HEAD", "OPTIONS", "get"]) {
    assert.ok(viewAsAllows(method, "/datasets/sales/dashboard/overview"), method);
    assert.ok(viewAsAllows(method, "/api/dashboards"), method);
  }
});

test("a dashboard's data is a read, though it is asked for with a POST", () => {
  assert.ok(viewAsAllows("POST", "/api/dashboards/run"));
});

test("everything that would write as them is refused", () => {
  const writes: [string, string][] = [
    ["POST", "/api/run"], // records history under their name
    ["POST", "/api/ask"],
    ["POST", "/api/chats"],
    ["POST", "/api/tokens"], // would mint a credential that is theirs
    ["POST", "/api/oauth/authorize/decide"], // would consent on their behalf
    ["POST", "/api/favorites"],
    ["DELETE", "/api/datasets/sales/drafts/abc"],
    ["PATCH", "/api/dashboards/sales/overview/sharing"],
    ["POST", "/api/dashboards/run/"], // exact path only: no prefix games
    ["POST", "/api/dashboards/runaway"],
  ];
  for (const [method, path] of writes) assert.ok(!viewAsAllows(method, path), `${method} ${path}`);
});

test("a request the proxy did not describe is refused", () => {
  // No method header means src/proxy.ts never saw the request. Treated as a
  // write to an unknown path rather than waved through.
  assert.ok(!viewAsAllows("", ""));
});
