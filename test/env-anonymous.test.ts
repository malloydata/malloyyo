// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT
//
// Guards the anonymous-access flag against accidental enablement. `env`'s
// getters read process.env live, so each case just sets vars and re-reads.
// Run: `npm run test:unit`.

import test from "node:test";
import assert from "node:assert/strict";
import { env } from "@/lib/env";

function set(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

test("anonymous is OFF by default (flag unset)", () => {
  set({ ALLOW_ANONYMOUS: undefined, INSTANCE_CODE: "worldcup", EMAIL_ALLOW_LIST: undefined });
  assert.equal(env.ALLOW_ANONYMOUS, false);
});

test("generic truthy values do NOT enable it (non-portable)", () => {
  for (const v of ["true", "1", "yes", "on", "TRUE"]) {
    set({ ALLOW_ANONYMOUS: v, INSTANCE_CODE: "worldcup", EMAIL_ALLOW_LIST: undefined });
    assert.equal(env.ALLOW_ANONYMOUS, false, `"${v}" must not enable anonymous`);
  }
});

test("only a value matching INSTANCE_CODE enables it", () => {
  set({ ALLOW_ANONYMOUS: "worldcup", INSTANCE_CODE: "worldcup", EMAIL_ALLOW_LIST: undefined });
  assert.equal(env.ALLOW_ANONYMOUS, true);
  // Case/whitespace tolerant.
  set({ ALLOW_ANONYMOUS: " WorldCup ", INSTANCE_CODE: "worldcup", EMAIL_ALLOW_LIST: undefined });
  assert.equal(env.ALLOW_ANONYMOUS, true);
});

test("a value for a DIFFERENT instance stays OFF (copied env)", () => {
  set({ ALLOW_ANONYMOUS: "worldcup", INSTANCE_CODE: "main", EMAIL_ALLOW_LIST: undefined });
  assert.equal(env.ALLOW_ANONYMOUS, false);
});

test("fail closed: an instance with EMAIL_ALLOW_LIST can never be anonymous", () => {
  set({ ALLOW_ANONYMOUS: "worldcup", INSTANCE_CODE: "worldcup", EMAIL_ALLOW_LIST: "a@b.com" });
  assert.equal(env.ALLOW_ANONYMOUS, false);
});
