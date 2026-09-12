// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// What a credential may reach — the one vocabulary, shared by API tokens and
// by OAuth grants. Its own module, with no imports, because the database
// schema, an OAuth route and a client component all need it, and pulling the
// schema into the browser bundle to read two strings would be silly.
//
// A union rather than a pgEnum: adding a scope should be data, not a migration.
export const API_TOKEN_SCOPES = ["publish", "mcp"] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

/** What each scope permits, in the words of the thing it unlocks. Shown on the
    token form and on the OAuth consent screen, so a person approving a client
    reads the same sentence the person minting a token does. */
export const SCOPE_DESCRIPTIONS: Record<ApiTokenScope, string> = {
  publish: "Publish models — malloyyo publish and malloyyo status",
  mcp: "Query this instance's published models over MCP",
};

export function isApiTokenScope(value: string): value is ApiTokenScope {
  return (API_TOKEN_SCOPES as readonly string[]).includes(value);
}

/** Stable order and no duplicates, whatever order they arrived in. */
export function normalizeScopes(scopes: ApiTokenScope[]): ApiTokenScope[] {
  return API_TOKEN_SCOPES.filter((s) => scopes.includes(s));
}

/**
 * An OAuth `scope` parameter (space-delimited, RFC 6749 §3.3) → our scopes.
 * Null when it names anything we don't grant, so the caller can answer
 * `invalid_scope` rather than silently narrowing a client's request.
 */
export function parseScopeString(raw: string): ApiTokenScope[] | null {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const out: ApiTokenScope[] = [];
  for (const p of parts) {
    if (!isApiTokenScope(p)) return null;
    out.push(p);
  }
  return normalizeScopes(out);
}

/** Back to the wire form stored on the grant and echoed in a token response. */
export function formatScopes(scopes: ApiTokenScope[]): string {
  return normalizeScopes(scopes).join(" ");
}

/**
 * The scopes an already-issued OAuth grant carries, read back from its stored
 * string. Anything unrecognized — including the bare `"mcp"` every grant
 * carried before publishing had a scope of its own — resolves to the NARROWEST
 * reading, never a broad one: a credential must not gain reach because its
 * scope string is from an older vintage.
 */
export function grantedScopes(raw: string): ApiTokenScope[] {
  const parsed = parseScopeString(raw ?? "");
  return parsed ?? ["mcp"];
}
