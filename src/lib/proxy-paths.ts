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

// ── cross-site writes ─────────────────────────────────────────────────────────
//
// The API's state-changing routes authenticate with the Auth.js session cookie
// and parse `request.json()`, which does not care about Content-Type. Until
// this check, the ONLY thing standing between a cross-site page and
// `POST /api/favorites` (or any other write) with the victim's cookie was the
// cookie's `SameSite=Lax` default — verified with a request carrying a foreign
// Origin and a text/plain body, which the server accepted. Lax is a browser
// default, not a server guarantee: it does not apply between two origins on the
// same registrable domain (a self-hoster's sibling subdomain), and it is not a
// defense at all for a client that ignores it.
//
// So a browser-originated write must come from this instance. The signal is
// the request's own `Origin` header — browsers send it on every cross-origin
// request and on every same-origin POST — compared against the origins this
// instance answers as. `Sec-Fetch-Site: cross-site` is the second signal, for
// a browser that sends it. A request with NEITHER header is not a browser
// (curl, a CLI, GitHub's webhook delivery) and passes; those routes
// authenticate with a bearer token or an HMAC, not a cookie, and the check
// applies only to requests that carry a session cookie in the first place.

const SESSION_COOKIE_RE = /(?:^|;\s*)(?:__Secure-)?authjs\.session-token(?:\.\d+)?=/;

/** Whether this request authenticates with the application's session cookie. */
export function carriesSessionCookie(cookieHeader: string | null): boolean {
  return !!cookieHeader && SESSION_COOKIE_RE.test(cookieHeader);
}

export interface WriteRequestShape {
  method: string;
  pathname: string;
  /** The request's `Origin` header, or null. */
  origin: string | null;
  /** The request's `Sec-Fetch-Site` header, or null. */
  secFetchSite: string | null;
  /** `Authorization` header present? Bearer-authenticated calls are not cookie writes. */
  hasAuthorization: boolean;
  /** `Cookie` header, or null. */
  cookie: string | null;
}

/**
 * Why a cookie-authenticated API write must be refused as cross-site, or null
 * when it may proceed. `allowedOrigins` are the origins this instance answers
 * as — the configured public URL plus whatever Host the request arrived on —
 * as bare `scheme://host[:port]` strings.
 */
export function crossSiteWriteRefusal(
  req: WriteRequestShape,
  allowedOrigins: readonly string[],
): string | null {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;
  if (!req.pathname.startsWith("/api/")) return null;
  // /api/auth is Auth.js (its own CSRF token); /api/oauth is bearer/PKCE.
  if (ALWAYS_ALLOW.test(req.pathname)) return null;
  // Only a request the cookie would authenticate. A bearer request is a
  // program's, and a request with no cookie has nothing to ride.
  if (req.hasAuthorization || !carriesSessionCookie(req.cookie)) return null;

  if (req.secFetchSite && req.secFetchSite.toLowerCase() === "cross-site") {
    return "cross-site request refused (Sec-Fetch-Site: cross-site)";
  }
  if (req.origin !== null) {
    const origin = req.origin.trim().toLowerCase().replace(/\/$/, "");
    // "null" is what a browser sends from an opaque origin (a sandboxed frame,
    // a data: URL) — never this instance's own page.
    if (origin === "null" || !allowedOrigins.some((a) => a.toLowerCase().replace(/\/$/, "") === origin)) {
      return `cross-site request refused (Origin ${req.origin} is not this instance)`;
    }
  }
  return null;
}
