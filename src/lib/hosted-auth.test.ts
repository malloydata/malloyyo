// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The pluggable-sign-in seam, as this build answers it.
//
// Every one of these is the *absent* case, which is the only case this repository has.
// They look trivial and they are the point: six sign-in route shells and src/auth.ts
// branch on these two answers, so if a build ever acquired an integration without anyone
// deciding to, this is what notices.
//
// The present case — an integration installed, screens mounted, providers contributed — is
// pinned beside the integration that implements it, against a real one.
//
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { hostedIntegration, hostedSignIn } from "./hosted-auth-integration.js";
import { signInPath, signOutPath } from "./auth-paths.js";

test("no integration is installed", () => {
  assert.equal(hostedIntegration(), null);
  assert.equal(hostedSignIn(), false);
});

// The two must agree. They are separate modules so that the cheap question can be asked
// without pulling in the database, which means nothing but this stops them drifting apart
// and reporting different things to different callers.
test("the cheap question agrees with the constructor", () => {
  assert.equal(hostedSignIn(), hostedIntegration() !== null);
});

// With no integration, sign-in and sign-out must point at NextAuth's own endpoints.
// Pointing them at /login and /logout would send people to shells that 404.
test("sign-in and sign-out route to the built-in endpoints", () => {
  assert.match(signInPath("/"), /^\/api\/auth\/signin\?/);
  assert.match(signOutPath("/"), /^\/api\/auth\/signout\?/);
});

// The callback URL is carried through and sanitized, integration or not — an open redirect
// here would be one regardless of who owns sign-in.
test("a foreign callback URL is not carried through", () => {
  const path = signInPath("https://evil.example/steal");
  assert.ok(!path.includes("evil.example"), `open redirect: ${path}`);
});
