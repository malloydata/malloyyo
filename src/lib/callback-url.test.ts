// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The open-redirect guard on the sign-in screen's `callbackUrl`.
//
// Worth its own test because the failure is invisible in normal use: every legitimate
// callbackUrl this app generates is a plain path, so a broken guard passes every manual
// check and only shows up when somebody hands a user a crafted link. The oracle is the
// URL spec's authority parsing, not anything this repo decides.
//
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { safeCallbackUrl } from "./callback-url";

test("keeps a same-origin path, including its query and fragment", () => {
  assert.equal(safeCallbackUrl("/ltool/abc"), "/ltool/abc");
  assert.equal(safeCallbackUrl("/datasets?sort=name"), "/datasets?sort=name");
  assert.equal(safeCallbackUrl("/"), "/");
});

test("refuses anything that would leave this instance", () => {
  // Each of these is a real redirect target a browser would follow off-origin. The first
  // two start with "/" and would pass a naive `startsWith("/")` check on their own.
  assert.equal(safeCallbackUrl("//evil.example"), "/");
  assert.equal(safeCallbackUrl("/\\evil.example"), "/");
  assert.equal(safeCallbackUrl("https://evil.example"), "/");
  assert.equal(safeCallbackUrl("http://evil.example/x"), "/");
  assert.equal(safeCallbackUrl("javascript:alert(1)"), "/");
  assert.equal(safeCallbackUrl("data:text/html,<script>"), "/");
});

test("falls back to the landing page when there is nothing to honor", () => {
  assert.equal(safeCallbackUrl(undefined), "/");
  assert.equal(safeCallbackUrl(null), "/");
  assert.equal(safeCallbackUrl(""), "/");
  // A bare path with no leading slash is relative to whatever page is showing, which is
  // not something the sign-in screen can resolve meaningfully.
  assert.equal(safeCallbackUrl("datasets"), "/");
});
