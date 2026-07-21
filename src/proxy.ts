// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { logger } from "@/lib/logger";
import { isEmailAllowed } from "@/lib/allowlist";

// Routes that must never be blocked — OAuth discovery, MCP, and auth itself.
const ALWAYS_ALLOW = /^\/(api\/auth|api\/oauth|\.well-known|mcp|oauth\/consent)/;

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  logger.info("request", { requestId, method: req.method, path: pathname, ip });

  // Propagate requestId so route handlers can correlate logs.
  const headers = new Headers(req.headers);
  headers.set("x-request-id", requestId);
  const next = () => NextResponse.next({ request: { headers } });

  if (ALWAYS_ALLOW.test(pathname)) return next();

  // API routes authenticate and authorize themselves (getSessionUser → 401
  // JSON). The middleware only guards PAGE navigations, where it can redirect
  // the browser to the sign-in screen.
  if (pathname.startsWith("/api/")) return next();

  const session = await auth();

  // Authentication: every page except the public landing requires a signed-in
  // user. Bounce anonymous visitors to Google sign-in and return them here
  // afterward (so e.g. a shared /ltool/<slug> link survives the round-trip).
  if (!session?.user?.email) {
    if (pathname === "/") return next(); // landing renders its own sign-in prompt
    const signInUrl = new URL("/api/auth/signin", req.url);
    signInUrl.searchParams.set("callbackUrl", req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(signInUrl);
  }

  // Authorization: the shared allow-list check (lib/allowlist — fail-open when
  // the list is unset; "@domain" entries admit the whole domain).
  if (!isEmailAllowed(session.user.email)) {
    // Signed in but not allowed — sign them out and redirect to home.
    logger.warn("access denied", { requestId, userId: session.user.id });
    const signOutUrl = new URL("/api/auth/signout", req.url);
    signOutUrl.searchParams.set("callbackUrl", "/");
    return NextResponse.redirect(signOutUrl);
  }

  return next();
}

export const config = {
  // Exclude static assets and the app icons (icon.svg / apple-icon) — otherwise an
  // anonymous browser's background favicon request gets auth-redirected, and its
  // callbackUrl (e.g. /icon.svg?<hash>) can win the sign-in round-trip.
  // dashboard-vendor.js is generic library code (React + Malloy renderer, no
  // secrets, no user data) loaded by the sandboxed dashboard iframe, whose opaque
  // origin sends no session cookie — it must be publicly fetchable. See
  // docs/dashboard-iframe-security.md.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon|dashboard-vendor.js).*)"],
};
