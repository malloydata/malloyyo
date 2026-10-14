// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Is an OAuth client claude.ai (web, Desktop, mobile)? Anthropic's connector docs
// give those apps one shared callback, https://claude.ai/api/mcp/auth_callback,
// possibly moving to claude.com. Claude Code and the malloyyo CLI register
// loopback callbacks instead. Every registered URI must be a Claude one: a client
// that also registered a loopback URI could have received its code there.
// Only picks the UI's connect hint (/api/me claudeConnected); it grants nothing.
const CLAUDE_HOSTS = new Set(["claude.ai", "claude.com"]);

export function isClaudeAiClient(redirectUris: readonly string[]): boolean {
  return redirectUris.length > 0 && redirectUris.every((u) => {
    try {
      const parsed = new URL(u);
      return parsed.protocol === "https:" && CLAUDE_HOSTS.has(parsed.hostname.toLowerCase());
    } catch {
      return false;
    }
  });
}
