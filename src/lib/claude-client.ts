// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Is an OAuth client one of Claude's hosted apps — claude.ai on the web,
// Desktop, mobile, Cowork? Decided by where it may be redirected.
//
// Anthropic's connector docs (claude.com/docs/connectors/building/authentication,
// "Callback URLs") say the hosted apps share ONE redirect URI,
// `https://claude.ai/api/mcp/auth_callback`; the help-centre article on remote
// MCP connectors adds that it may move to the same path on claude.com, so both
// hosts count. Claude Code is different: a native client on a loopback
// redirect (`http://localhost:<port>/callback`), and so is the malloyyo CLI's
// login. This server advertises dynamic client registration and nothing else,
// so every client that holds a token has an `oauth_clients` row carrying the
// redirect URIs it registered.
//
// EVERY registered URI must be a Claude callback, not just one: a client that
// also registered a loopback URI could have received its code there. Claude's
// hosted apps register exactly the one.
//
// Used only for the UI's "is Claude connected?" hint (/api/me's
// claudeConnected), which picks between opening a seeded claude.ai chat and
// showing the connect-setup steps. It grants nothing: authentication and
// scopes are decided elsewhere (src/lib/bearer-auth.ts).
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
