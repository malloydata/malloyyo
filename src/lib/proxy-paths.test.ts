// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  carriesSessionCookie,
  crossSiteWriteRefusal,
  renewalApplies,
  shouldUseReauth,
  type WriteRequestShape,
} from "./proxy-paths";

test("renewal applies only to protected page reads", () => {
  assert.equal(renewalApplies("GET", "/datasets"), true);
  assert.equal(renewalApplies("HEAD", "/admin"), true);
  assert.equal(renewalApplies("GET", "/api/datasets"), false);
  assert.equal(renewalApplies("GET", "/logout"), false);
  assert.equal(renewalApplies("GET", "/reauth"), false);
  assert.equal(renewalApplies("POST", "/datasets"), false);
});

test("a provider-shaped cookie selects reauth only for an installed integration", () => {
  assert.equal(shouldUseReauth(false, false), false);
  assert.equal(shouldUseReauth(false, true), false);
  assert.equal(shouldUseReauth(true, false), false);
  assert.equal(shouldUseReauth(true, true), true);
});

// ── cross-site writes (security review 2026-10) ──────────────────────────────

const ALLOWED = ["https://yo.example.com", "http://localhost:3000"];

function write(over: Partial<WriteRequestShape> = {}): WriteRequestShape {
  return {
    method: "POST",
    pathname: "/api/favorites",
    origin: "https://yo.example.com",
    secFetchSite: "same-origin",
    hasAuthorization: false,
    cookie: "authjs.session-token=abc",
    ...over,
  };
}

test("recognizes the session cookie under both names, and chunked", () => {
  assert.equal(carriesSessionCookie("authjs.session-token=abc"), true);
  assert.equal(carriesSessionCookie("x=1; __Secure-authjs.session-token=abc"), true);
  assert.equal(carriesSessionCookie("authjs.session-token.0=abc; authjs.session-token.1=def"), true);
  assert.equal(carriesSessionCookie("authjs.csrf-token=abc; authjs.callback-url=x"), false);
  assert.equal(carriesSessionCookie("notauthjs.session-token=abc"), false);
  assert.equal(carriesSessionCookie(null), false);
});

test("a same-origin browser write proceeds", () => {
  assert.equal(crossSiteWriteRefusal(write(), ALLOWED), null);
  // The configured origin and the request Host may differ behind a proxy; either matches.
  assert.equal(crossSiteWriteRefusal(write({ origin: "http://localhost:3000" }), ALLOWED), null);
  // Case and a trailing slash are not a different origin.
  assert.equal(crossSiteWriteRefusal(write({ origin: "https://YO.example.com/" }), ALLOWED), null);
});

test("a cookie-bearing write from another origin is refused", () => {
  assert.match(
    crossSiteWriteRefusal(write({ origin: "https://evil.example", secFetchSite: null }), ALLOWED) ?? "",
    /cross-site/,
  );
  // A sandboxed/opaque origin sends the literal "null".
  assert.match(crossSiteWriteRefusal(write({ origin: "null", secFetchSite: null }), ALLOWED) ?? "", /cross-site/);
  // Sec-Fetch-Site alone is enough, whatever Origin says.
  assert.match(crossSiteWriteRefusal(write({ secFetchSite: "cross-site" }), ALLOWED) ?? "", /Sec-Fetch-Site/);
  // A sibling subdomain is exactly the case SameSite=Lax does not cover.
  assert.match(
    crossSiteWriteRefusal(write({ origin: "https://other.example.com", secFetchSite: null }), ALLOWED) ?? "",
    /cross-site/,
  );
});

test("reads, non-API paths, and the auth/OAuth endpoints are untouched", () => {
  assert.equal(crossSiteWriteRefusal(write({ method: "GET", origin: "https://evil.example" }), ALLOWED), null);
  assert.equal(crossSiteWriteRefusal(write({ method: "OPTIONS", origin: "https://evil.example" }), ALLOWED), null);
  assert.equal(crossSiteWriteRefusal(write({ pathname: "/datasets/x", origin: "https://evil.example" }), ALLOWED), null);
  assert.equal(crossSiteWriteRefusal(write({ pathname: "/api/auth/callback/google", origin: "https://accounts.google.com" }), ALLOWED), null);
  assert.equal(crossSiteWriteRefusal(write({ pathname: "/api/oauth/token", origin: "https://claude.ai" }), ALLOWED), null);
});

test("non-browser callers pass: bearer tokens, no cookie, no Origin", () => {
  // The CLI and claude.ai: a bearer token and no session cookie.
  assert.equal(
    crossSiteWriteRefusal(write({ hasAuthorization: true, cookie: null, origin: "https://claude.ai", secFetchSite: null }), ALLOWED),
    null,
  );
  // A bearer request that also happens to carry a cookie is still a program's request.
  assert.equal(
    crossSiteWriteRefusal(write({ hasAuthorization: true, origin: "https://claude.ai", secFetchSite: null }), ALLOWED),
    null,
  );
  // GitHub's webhook delivery: no cookie, no Origin, no Sec-Fetch-Site.
  assert.equal(
    crossSiteWriteRefusal(
      write({ pathname: "/api/repos/abc/webhook/github", cookie: null, origin: null, secFetchSite: null }),
      ALLOWED,
    ),
    null,
  );
  // A cookie but no Origin at all (an old browser, or a non-browser client holding a cookie).
  assert.equal(crossSiteWriteRefusal(write({ origin: null, secFetchSite: null }), ALLOWED), null);
});
