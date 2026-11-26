// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Viewing as another user is LOOK-ONLY, and this is the rule that makes it so
// (src/lib/view-as.ts). `getSessionUser()` applies it to every request made
// while an admin is viewing as someone.

import test from "node:test";
import assert from "node:assert/strict";
import {
  isRefusedPage,
  proxyRefusesForViewAs,
  VIEW_AS_PERSONAL_REFUSAL,
  VIEW_AS_REFUSAL,
  viewAsAllows,
  viewAsRefusal,
} from "./view-as";
import { mintViewAsToken, verifyViewAsToken } from "./view-as-token";

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
  assert.ok(!proxyRefusesForViewAs(true, "GET", "/api/history"));
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

// Impersonating shows what the instance GIVES someone. What they wrote or hold
// is theirs: an admin cannot read another person's unpublished chats (they
// carry stored result rows) or see their API tokens, and the identity swap must
// not hand those over by the side door.
test("the person's own chats and tokens are not shown, reads included", () => {
  const personal: [string, string][] = [
    ["GET", "/api/chats"],
    ["GET", "/api/chats/3f0c2a1e-0000-4000-8000-000000000000"],
    ["GET", "/api/tokens"],
    ["GET", "/chat"],
    ["GET", "/chat/3f0c2a1e-0000-4000-8000-000000000000"],
    ["GET", "/settings/tokens"],
    ["POST", "/api/chats/abc/messages"],
  ];
  for (const [method, path] of personal) {
    assert.ok(!viewAsAllows(method, path), `${method} ${path}`);
    assert.ok(proxyRefusesForViewAs(true, method, path), `proxy: ${method} ${path}`);
    assert.equal(viewAsRefusal(path), VIEW_AS_PERSONAL_REFUSAL);
  }
  // A page is sent home; an API route is answered.
  assert.ok(isRefusedPage("/chat") && isRefusedPage("/settings/tokens"));
  assert.ok(!isRefusedPage("/api/chats") && !isRefusedPage("/datasets/sales"));
  // Prefixes, not substrings: nothing else is caught by the name.
  assert.ok(viewAsAllows("GET", "/chatter"));
  assert.ok(viewAsAllows("GET", "/api/tokens-help"));
  assert.ok(viewAsAllows("GET", "/settings"));
  // And a write elsewhere still gets the look-only sentence.
  assert.equal(viewAsRefusal("/api/favorites"), VIEW_AS_REFUSAL);
});

// The cookie is the start route's signature over (admin, target, start time).
// Before it was signed it was a bare user id, and "ends after an hour" and "it
// is logged that you looked" were both only true of a browser that behaved.
test("the impersonation cookie: minted for one admin, good for an hour, and nothing else is", () => {
  const before = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = "test-secret-for-view-as";
  try {
    const ADMIN = "11111111-1111-4111-8111-111111111111";
    const OTHER_ADMIN = "22222222-2222-4222-8222-222222222222";
    const TARGET = "33333333-3333-4333-8333-333333333333";
    const t0 = Date.UTC(2026, 10, 26, 12, 0, 0);
    const token = mintViewAsToken({ adminId: ADMIN, targetId: TARGET }, t0);
    assert.ok(token);

    assert.equal(verifyViewAsToken(token!, ADMIN, t0 + 60_000), TARGET);
    // The hour is the server's, not the cookie's max-age.
    assert.equal(verifyViewAsToken(token!, ADMIN, t0 + 59 * 60_000), TARGET);
    assert.equal(verifyViewAsToken(token!, ADMIN, t0 + 61 * 60_000), null, "past its hour");
    assert.equal(verifyViewAsToken(token!, ADMIN, t0 - 60_000), null, "from the future");
    // Bound to the admin it was minted for: the next admin on that browser is
    // not impersonating anyone.
    assert.equal(verifyViewAsToken(token!, OTHER_ADMIN, t0 + 60_000), null);
    // What the cookie USED to be: a bare id, set by hand, never logged.
    assert.equal(verifyViewAsToken(TARGET, ADMIN, t0), null);
    assert.equal(verifyViewAsToken(undefined, ADMIN, t0), null);
    assert.equal(verifyViewAsToken("", ADMIN, t0), null);
    // Tampering with who is named breaks the signature.
    const [payload, sig] = token!.split(".");
    const forged = Buffer.from(JSON.stringify({ a: ADMIN, t: OTHER_ADMIN, iat: Math.floor(t0 / 1000) })).toString("base64url");
    assert.equal(verifyViewAsToken(`${forged}.${sig}`, ADMIN, t0), null);
    assert.equal(verifyViewAsToken(`${payload}.${sig}x`, ADMIN, t0), null);
    // A different secret verifies nothing.
    process.env.AUTH_SECRET = "another-secret";
    assert.equal(verifyViewAsToken(token!, ADMIN, t0 + 60_000), null);
  } finally {
    if (before === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = before;
  }
});

test("with no signing secret there is no impersonation, rather than an unsigned one", () => {
  const saved = { a: process.env.AUTH_SECRET, d: process.env.DASHBOARD_TOKEN_SECRET };
  delete process.env.AUTH_SECRET;
  delete process.env.DASHBOARD_TOKEN_SECRET;
  try {
    assert.equal(mintViewAsToken({ adminId: "a", targetId: "t" }), null);
    assert.equal(verifyViewAsToken("anything.at-all", "a"), null);
  } finally {
    if (saved.a !== undefined) process.env.AUTH_SECRET = saved.a;
    if (saved.d !== undefined) process.env.DASHBOARD_TOKEN_SECRET = saved.d;
  }
});
