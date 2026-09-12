// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The scope vocabulary, shared by API tokens and OAuth grants. `grantedScopes`
// is the security-relevant one: it reads a scope string that may have been
// written by an older version of this application, and must never answer with
// more reach than the string actually names.
//
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  API_TOKEN_SCOPES,
  SCOPE_DESCRIPTIONS,
  formatScopes,
  grantedScopes,
  isApiTokenScope,
  normalizeScopes,
  parseScopeString,
} from "./api-token-scopes.js";

test("parseScopeString takes a space-delimited subset, in a stable order", () => {
  assert.deepEqual(parseScopeString("mcp"), ["mcp"]);
  assert.deepEqual(parseScopeString("publish"), ["publish"]);
  assert.deepEqual(parseScopeString("mcp publish"), ["publish", "mcp"]);
  assert.deepEqual(parseScopeString("publish mcp"), ["publish", "mcp"]);
  // Extra whitespace is how real clients serialize; duplicates collapse.
  assert.deepEqual(parseScopeString("  mcp   publish  "), ["publish", "mcp"]);
  assert.deepEqual(parseScopeString("mcp mcp"), ["mcp"]);
});

test("parseScopeString refuses anything outside the vocabulary rather than narrowing", () => {
  // A client that asked for "admin" must get invalid_scope, not a quiet
  // downgrade to whatever we happened to recognize.
  for (const bad of ["", "   ", "admin", "mcp admin", "MCP", "publish,mcp", "mcp:read"]) {
    assert.equal(parseScopeString(bad), null, `should refuse: ${JSON.stringify(bad)}`);
  }
});

test("grantedScopes reads a stored grant, and an unknown vintage is the NARROWEST", () => {
  assert.deepEqual(grantedScopes("mcp publish"), ["publish", "mcp"]);
  assert.deepEqual(grantedScopes("publish"), ["publish"]);

  // Every grant issued before publishing had a scope of its own says exactly
  // this. It must NOT be read as full authority: that is what would let a
  // claude.ai connection — delegated for querying — overwrite a model.
  assert.deepEqual(grantedScopes("mcp"), ["mcp"]);

  // Junk, empty, or a scope some future version issued and this one doesn't
  // know: all of it falls back to MCP alone, never to publish.
  for (const odd of ["", "   ", "admin", "everything", "mcp admin"]) {
    assert.deepEqual(grantedScopes(odd), ["mcp"], `should be mcp-only: ${JSON.stringify(odd)}`);
  }
});

test("formatScopes round-trips through parseScopeString", () => {
  for (const raw of ["mcp", "publish", "mcp publish"]) {
    const parsed = parseScopeString(raw);
    assert.ok(parsed);
    assert.deepEqual(parseScopeString(formatScopes(parsed)), parsed);
  }
  assert.equal(formatScopes(["mcp", "publish"]), "publish mcp");
});

test("normalizeScopes and isApiTokenScope agree with the vocabulary", () => {
  assert.deepEqual(normalizeScopes(["mcp", "publish", "mcp"]), ["publish", "mcp"]);
  assert.deepEqual(normalizeScopes([]), []);
  assert.equal(isApiTokenScope("publish"), true);
  assert.equal(isApiTokenScope("admin"), false);
});

test("every scope has a description, because two screens render them", () => {
  // The token form and the OAuth consent screen both read this map; a scope
  // added without one would render as a blank permission line.
  for (const scope of API_TOKEN_SCOPES) {
    assert.ok(SCOPE_DESCRIPTIONS[scope]?.length > 0, `no description for ${scope}`);
  }
});
