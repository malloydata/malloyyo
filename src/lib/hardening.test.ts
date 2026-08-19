// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Small hardening items from the security review, pinned together because
// each is one function and none warrants its own file:
//
//   L1        — the dashboard frame token gets its own secret, so the dashboard
//               subsystem no longer breaks when the auth mechanism changes.
//   Finding 5 — superseded: the open-access warning used to key on a missing
//               EMAIL_ALLOW_LIST; membership now lives in the database, the
//               default policy is fail-closed (`invite`), and the warning that
//               replaced it is pinned below — the retired variable must warn
//               loudly when set, naming where it disagrees with the database,
//               because editing it changes nothing.
//   §6 note   — HMAC verification on the GitHub push webhook.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { retiredAllowListWarning } from "./access-warnings.js";
import { verifyGitHubSignature } from "./github-webhook.js";
import { mintFrameToken, verifyFrameToken } from "./dashboards/frame-token.js";
import crypto from "node:crypto";

const KEYS = [
  "AUTH_SECRET",
  "DASHBOARD_TOKEN_SECRET",
  "GITHUB_WEBHOOK_SECRET",
] as const;
const SAVED = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const CLAIMS = { userId: "u1", datasetId: "d1", name: "sales" };

// --- L1: the frame token's own secret ---------------------------------------

test("frame tokens sign and verify with DASHBOARD_TOKEN_SECRET", () => {
  delete process.env.AUTH_SECRET;
  process.env.DASHBOARD_TOKEN_SECRET = "dashboard-key-aaaaaaaaaaaaaaaaaaaa";
  assert.deepEqual(verifyFrameToken(mintFrameToken(CLAIMS)), CLAIMS);
});

test("with no DASHBOARD_TOKEN_SECRET it falls back to AUTH_SECRET", () => {
  // The compatibility path: every existing deployment keeps working with no
  // new configuration.
  delete process.env.DASHBOARD_TOKEN_SECRET;
  process.env.AUTH_SECRET = "auth-key-bbbbbbbbbbbbbbbbbbbbbbbb";
  assert.deepEqual(verifyFrameToken(mintFrameToken(CLAIMS)), CLAIMS);
});

test("a dashboard instance works with AUTH_SECRET absent entirely", () => {
  // L1's actual point: an instance authenticating some other way carries no
  // AUTH_SECRET, and dashboards used to 500 at request time because of it.
  delete process.env.AUTH_SECRET;
  process.env.DASHBOARD_TOKEN_SECRET = "dashboard-key-cccccccccccccccccccc";
  assert.doesNotThrow(() => mintFrameToken(CLAIMS));
});

test("DASHBOARD_TOKEN_SECRET takes precedence, so a token from the other key is rejected", () => {
  process.env.AUTH_SECRET = "auth-key-bbbbbbbbbbbbbbbbbbbbbbbb";
  delete process.env.DASHBOARD_TOKEN_SECRET;
  const mintedUnderAuthSecret = mintFrameToken(CLAIMS);
  process.env.DASHBOARD_TOKEN_SECRET = "dashboard-key-aaaaaaaaaaaaaaaaaaaa";
  assert.equal(verifyFrameToken(mintedUnderAuthSecret), null);
});

test("neither secret set is a clear error, not a silently unsigned token", () => {
  delete process.env.AUTH_SECRET;
  delete process.env.DASHBOARD_TOKEN_SECRET;
  assert.throws(() => mintFrameToken(CLAIMS), /DASHBOARD_TOKEN_SECRET/);
});

// --- the retired EMAIL_ALLOW_LIST must warn loudly ---------------------------
//
// The variable is no longer read: an operator who edits it and redeploys
// changes nothing, silently, and that silence reads as a bug in sign-in.

test("a set list warns that it is retired, even when it agrees with the database", () => {
  const w = retiredAllowListWarning("you@example.com", {
    activeEmails: ["you@example.com"],
    openInvitationEmails: [],
  });
  assert.ok(w, "expected a warning");
  assert.match(w, /NO LONGER READ/);
  assert.match(w, /BREAK_GLASS_EMAIL/);
});

test("an unset or blank list is silent — nothing stale to warn about", () => {
  assert.equal(retiredAllowListWarning(undefined, { activeEmails: [], openInvitationEmails: [] }), null);
  assert.equal(retiredAllowListWarning("   ", { activeEmails: ["a@b.c"], openInvitationEmails: [] }), null);
});

test("names listed addresses that are neither active nor invited", () => {
  // The operator added a colleague to the variable and redeployed; nothing
  // happened. This is the line that says why.
  const w = retiredAllowListWarning("you@example.com, colleague@example.com", {
    activeEmails: ["you@example.com"],
    openInvitationEmails: [],
  });
  assert.ok(w);
  assert.match(w, /colleague@example\.com/);
  assert.match(w, /invite or approve/);
});

test("an open invitation counts as agreement — the person is admitted, just not arrived", () => {
  const w = retiredAllowListWarning("you@example.com,colleague@example.com", {
    activeEmails: ["you@example.com"],
    openInvitationEmails: ["colleague@example.com"],
  });
  assert.ok(w);
  assert.doesNotMatch(w, /invite or approve/);
});

test("names active users the list would have excluded", () => {
  const w = retiredAllowListWarning("you@example.com", {
    activeEmails: ["you@example.com", "stranger@example.com"],
    openInvitationEmails: [],
  });
  assert.ok(w);
  assert.match(w, /stranger@example\.com/);
  assert.match(w, /not\s+excluding them/);
});

test("comparison is case-insensitive, like the list always was", () => {
  const w = retiredAllowListWarning("You@Example.com", {
    activeEmails: ["YOU@EXAMPLE.COM"],
    openInvitationEmails: [],
  });
  assert.ok(w);
  assert.doesNotMatch(w, /invite or approve/);
  assert.doesNotMatch(w, /not\s+excluding them/);
});

// --- GitHub webhook signature ------------------------------------------------

const BODY = JSON.stringify({ ref: "refs/heads/main" });
const sign = (body: string, key: string) =>
  `sha256=${crypto.createHmac("sha256", key).update(body).digest("hex")}`;

test("accepts a correctly signed delivery", () => {
  process.env.GITHUB_WEBHOOK_SECRET = "hook-key";
  assert.equal(verifyGitHubSignature(BODY, sign(BODY, "hook-key")), true);
});

test("rejects a wrong key, a tampered body, and a missing header", () => {
  process.env.GITHUB_WEBHOOK_SECRET = "hook-key";
  assert.equal(verifyGitHubSignature(BODY, sign(BODY, "other-key")), false);
  assert.equal(verifyGitHubSignature(BODY, sign(BODY + " ", "hook-key")), false, "tampered body");
  assert.equal(verifyGitHubSignature(BODY, null), false, "missing header");
  assert.equal(verifyGitHubSignature(BODY, "sha256=short"), false, "length mismatch must not throw");
});

test("verification is off unless the secret is configured", () => {
  // Deliberate: failing closed by default would break every webhook already
  // registered in GitHub the moment this ships.
  delete process.env.GITHUB_WEBHOOK_SECRET;
  assert.equal(verifyGitHubSignature(BODY, null), true);
  process.env.GITHUB_WEBHOOK_SECRET = "  ";
  assert.equal(verifyGitHubSignature(BODY, null), true, "blank counts as unset");
});
