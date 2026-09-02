// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Build identity as the admin header shows it. The interesting cases are the
// ones where the platform tells us nothing, or tells us something malformed —
// this string is a diagnostic, so a wrong or half-formed answer is worse than
// no answer.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { VERSION, shortSha, buildLabel } from "./version";

const VARS = ["GIT_COMMIT_SHA", "VERCEL_GIT_COMMIT_SHA"] as const;
const clear = () => VARS.forEach((v) => delete process.env[v]);
afterEach(clear);

test("with no commit in the environment, the label is the bare version", () => {
  clear();
  assert.equal(shortSha(), undefined);
  assert.equal(buildLabel(), VERSION);
  // `npm run dev` is this case, so it must read as normal rather than broken.
  assert.doesNotMatch(buildLabel(), /undefined|·/);
});

test("Vercel's system variable is picked up and abbreviated", () => {
  clear();
  process.env.VERCEL_GIT_COMMIT_SHA = "064c6b5a1b2c3d4e5f60718293a4b5c6d7e8f900";
  assert.equal(shortSha(), "064c6b5");
  assert.equal(buildLabel(), `${VERSION} · 064c6b5`);
});

test("the portable spelling wins, so a self-hoster can override the platform", () => {
  clear();
  process.env.VERCEL_GIT_COMMIT_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  process.env.GIT_COMMIT_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  assert.equal(shortSha(), "bbbbbbb");
});

test("an already-short sha is used as-is", () => {
  clear();
  process.env.GIT_COMMIT_SHA = "064c6b5";
  assert.equal(shortSha(), "064c6b5");
});

test("a sha is normalized to lower case", () => {
  clear();
  process.env.GIT_COMMIT_SHA = "064C6B5A1B2C3D4E5F60718293A4B5C6D7E8F900";
  assert.equal(shortSha(), "064c6b5");
});

test("anything that isn't a commit hash is ignored, not displayed", () => {
  // A placeholder or an unexpanded template is the realistic failure — showing
  // it would put a lie in the header, which is worse than showing nothing.
  for (const junk of [
    "",
    "unknown",
    "HEAD",
    "$VERCEL_GIT_COMMIT_SHA",
    "064c6b",
    "064c6b5a1b2c3d4e5f60718293a4b5c6d7e8f9001",
    "064c6b5-dirty",
    "064c6b5 ",
    "zzzzzzz",
  ]) {
    clear();
    process.env.GIT_COMMIT_SHA = junk;
    assert.equal(shortSha(), undefined, `expected ${JSON.stringify(junk)} to be rejected`);
    assert.equal(buildLabel(), VERSION);
  }
});

test("the version itself comes from the manifest", () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
});

test("/api/version reports the commit when the build has one, and omits it when not", async () => {
  // The endpoint is how a deploy check asks "what code are you?" without a
  // browser. `sha` is absent rather than null on a build with no commit, so a
  // caller can test presence instead of distinguishing null from a placeholder.
  const route = await import("../app/api/version/route.js");

  const sha = "064c6b5abcdef";
  process.env.GIT_COMMIT_SHA = sha;
  const withSha = await (route.GET() as Response).json();
  assert.equal(withSha.sha, sha.slice(0, 7));
  assert.equal(withSha.version, VERSION);

  delete process.env.GIT_COMMIT_SHA;
  delete process.env.VERCEL_GIT_COMMIT_SHA;
  const without = await (route.GET() as Response).json();
  assert.equal("sha" in without, false, "omitted, not null");
  assert.equal(without.version, VERSION);
});
