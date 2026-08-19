// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Short-lived, signed capability token that lets the SANDBOXED dashboard iframe
// load its own static assets (the compiled bundle) without an ambient session
// cookie. The iframe runs with sandbox="allow-scripts" (no allow-same-origin),
// so it is an opaque origin whose subresource requests carry no SameSite cookie
// — see docs/dashboard-iframe-security.md. The trusted frame route, which IS
// cookie-authed (the subframe navigation still carries the cookie, and later a
// separate artifact origin would pass a token), mints this token for the viewer
// and embeds it in the bundle URL.
//
// Scope is deliberately narrow: it authorizes reading THIS (viewer, dataset,
// dashboard)'s static assets only. It never authorizes a data run — that stays
// brokered by the trusted parent page with the real session — so even though the
// guest can read the token out of its own document, it grants no escalation.

import crypto from "node:crypto";

const TTL_SECONDS = 300; // 5 min — ample to load the frame + bundle once.

// The dashboard subsystem owns its own signing key, with AUTH_SECRET as the
// compatibility fallback so existing deployments need no new configuration.
//
// Why it can't just read AUTH_SECRET: that var belongs to Auth.js, and an
// instance authenticating some other way may legitimately not set it. Reading
// it here made dashboards fail at RUNTIME with a 500 — not at startup, and only
// on dashboard routes, which is the kind of break that ships. The dependency
// was invisible: nothing about "dashboard iframe capability token" suggests it
// stops working when you change how users sign in.
//
// Note for operators: setting DASHBOARD_TOKEN_SECRET on a running instance
// invalidates in-flight frame tokens. Their TTL is 5 minutes, so the blast
// radius is a dashboard open at that moment needing a refresh.
function secret(): string {
  const s = process.env.DASHBOARD_TOKEN_SECRET ?? process.env.AUTH_SECRET;
  if (!s) {
    throw new Error("Missing required env var: DASHBOARD_TOKEN_SECRET (or AUTH_SECRET) — needed to sign dashboard frame tokens");
  }
  return s;
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
}

export interface FrameTokenClaims {
  userId: string;
  datasetId: string;
  name: string;
}

export function mintFrameToken(claims: FrameTokenClaims): string {
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const payload = Buffer.from(JSON.stringify({ ...claims, exp })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** Verify signature + expiry; returns the claims or null. Does NOT check that the
 *  claims match a given route — the caller must compare datasetId/name itself. */
export function verifyFrameToken(token: string): FrameTokenClaims | null {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    return null;
  }
  if (typeof claims !== "object" || claims === null) return null;
  const c = claims as Record<string, unknown>;
  if (typeof c.exp !== "number" || c.exp < Math.floor(Date.now() / 1000)) return null;
  if (typeof c.userId !== "string" || typeof c.datasetId !== "string" || typeof c.name !== "string") return null;
  return { userId: c.userId, datasetId: c.datasetId, name: c.name };
}
