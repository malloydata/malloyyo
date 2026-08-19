// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { renewalApplies, shouldUseReauth } from "./proxy-paths";

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
