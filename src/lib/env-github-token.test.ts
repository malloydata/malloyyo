// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The GITHUB_TOKEN fallback chain. Oracle: the two-name contract with hosted
// provisioning — the user's own token always wins, an *empty* user token means unset
// (and must fall through, not authenticate as an empty string), and with neither name
// present the getter yields "" so callers skip the Authorization header entirely
// (src/lib/github.ts gates on truthiness).
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { env } from "./env";

const saved = {
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  GITHUB_TOKEN_FALLBACK: process.env.GITHUB_TOKEN_FALLBACK,
};

function set(name: keyof typeof saved, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  set("GITHUB_TOKEN", saved.GITHUB_TOKEN);
  set("GITHUB_TOKEN_FALLBACK", saved.GITHUB_TOKEN_FALLBACK);
});

describe("env.GITHUB_TOKEN", () => {
  test("the user's own token wins over the fallback", () => {
    set("GITHUB_TOKEN", "ghp_user");
    set("GITHUB_TOKEN_FALLBACK", "ghp_platform");
    assert.equal(env.GITHUB_TOKEN, "ghp_user");
  });

  test("an unset or empty user token falls back", () => {
    set("GITHUB_TOKEN_FALLBACK", "ghp_platform");
    for (const value of [undefined, ""]) {
      set("GITHUB_TOKEN", value);
      assert.equal(env.GITHUB_TOKEN, "ghp_platform");
    }
  });

  test("with neither set, the getter is empty so requests go unauthenticated", () => {
    set("GITHUB_TOKEN", undefined);
    set("GITHUB_TOKEN_FALLBACK", undefined);
    assert.equal(env.GITHUB_TOKEN, "");
  });
});
