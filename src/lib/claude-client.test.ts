// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// /api/me's claudeConnected used to be "any live OAuth token", so a user whose
// only grant came from the malloyyo CLI's login (or Claude Code) read as
// connected, and "Explore in Claude" opened a claude.ai chat with no tools for
// the instance instead of the setup steps.

import assert from "node:assert/strict";
import { test } from "node:test";
import { isClaudeAiClient } from "./claude-client";

test("the hosted apps' documented callback counts, on claude.ai and claude.com", () => {
  assert.equal(isClaudeAiClient(["https://claude.ai/api/mcp/auth_callback"]), true);
  assert.equal(isClaudeAiClient(["https://claude.com/api/mcp/auth_callback"]), true);
  assert.equal(isClaudeAiClient(["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"]), true);
  assert.equal(isClaudeAiClient(["https://Claude.AI/api/mcp/auth_callback"]), true);
});

test("the malloyyo CLI and Claude Code (loopback callbacks) do not", () => {
  assert.equal(isClaudeAiClient(["http://127.0.0.1:53123/callback"]), false);
  assert.equal(isClaudeAiClient(["http://localhost:8976/callback"]), false);
  assert.equal(isClaudeAiClient(["http://[::1]:8976/callback"]), false);
  assert.equal(isClaudeAiClient([]), false);
});

test("a client that ALSO registered a non-Claude callback does not", () => {
  assert.equal(isClaudeAiClient(["https://claude.ai/api/mcp/auth_callback", "http://localhost:8976/callback"]), false);
  assert.equal(isClaudeAiClient(["https://claude.ai/api/mcp/auth_callback", "https://example.com/cb"]), false);
});

test("look-alike, sub- and non-https hosts do not", () => {
  assert.equal(isClaudeAiClient(["https://claude.ai.example.com/cb"]), false);
  assert.equal(isClaudeAiClient(["https://notclaude.ai/cb"]), false);
  assert.equal(isClaudeAiClient(["https://evil.claude.ai.attacker.net/cb"]), false);
  assert.equal(isClaudeAiClient(["http://claude.ai/api/mcp/auth_callback"]), false);
  assert.equal(isClaudeAiClient(["not a url"]), false);
});
