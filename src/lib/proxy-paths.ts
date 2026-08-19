// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Routing policy shared by proxy.ts and its unit tests.

// OAuth discovery, MCP, and every authentication screen must stay reachable without an
// application session. /logout is especially important: renewing there would resurrect
// the session the visitor just ended.
export const ALWAYS_ALLOW =
  /^\/(api\/auth|api\/oauth|\.well-known|mcp|oauth\/consent|login|logout|authenticate|reauth)/;

/** Server-side renewal is only a safe, useful pre-pass for page reads. */
export function renewalApplies(method: string, pathname: string): boolean {
  return (
    (method === "GET" || method === "HEAD") &&
    !pathname.startsWith("/api/") &&
    !ALWAYS_ALLOW.test(pathname)
  );
}

export function reauthPath(callbackUrl: string): string {
  const params = new URLSearchParams({ callbackUrl });
  return `/reauth?${params.toString()}`;
}

/** A provider-shaped cookie is meaningful only when this build installed an integration. */
export function shouldUseReauth(
  hasIntegration: boolean,
  hasProviderSessionCookie: boolean,
): boolean {
  return hasIntegration && hasProviderSessionCookie;
}
