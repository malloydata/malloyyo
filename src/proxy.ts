// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import type { NextAuthRequest } from "next-auth";
import { logger } from "@/lib/logger";
import { auth } from "@/auth";
import { signInPath } from "@/lib/auth-paths";
import { requestHasCookie, renewAppSessionInPlace } from "@/lib/app-session";
import { hostedIntegration } from "@/lib/hosted-auth-integration";
import {
  ALWAYS_ALLOW,
  reauthPath,
  renewalApplies,
  shouldUseReauth,
} from "@/lib/proxy-paths";

const STYTCH_SESSION_COOKIE = "stytch_session_jwt";

// Renewal is a pre-pass outside auth(), while the request is still its input. When the
// integration verifies a live provider session, the application mints its own Auth.js JWT
// and injects it into req.headers. The wrapper then sees an ordinary valid session: req.auth
// is populated for this request, server components receive the same mutated cookie header,
// and Auth.js appends the rotated Set-Cookie it owns.
//
// This placement also avoids Auth.js's invalid-session clearing cookie. The wrapper computes
// its session response before invoking our callback and appends those cookies afterwards; a
// token placed only on our response would be silently cleared last.
//
// The callback remains wrapped in `auth()` rather than calling `auth()` inside, and that is
// what keeps a working session alive.
//
// Auth.js re-signs the session token with a fresh expiry every time the session is read
// (@auth/core/lib/actions/session.js: "Refresh JWT expiry by re-signing it"), and hands the
// new cookie back on the session response. Only this wrapper copies that `Set-Cookie` onto
// the outgoing response — a bare `await auth()` reads the session and drops it.
//
// Without the wrapper the session lifetime is an **absolute** hour: somebody working
// continuously was signed out mid-task at sixty minutes, exactly like somebody who had been
// idle. With it the hour becomes an idle timeout, which is what it was always documented to
// be, and an active person is never interrupted.
//
// `req.auth` is the session this wrapper already resolved; reading it again here would
// throw the rotated cookie away a second time.
const handleAuth = auth(async (req: NextAuthRequest, _event: NextFetchEvent) => {
  const { pathname } = req.nextUrl;

  const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  // Exactly one "request" line per request. Page navigations resolve the
  // session first so the line carries userId alongside the IP; the paths that
  // return early authenticate downstream and log their own userId there
  // (bearer routes) or not at all.
  const logRequest = (userId?: string) =>
    logger.info("request", { requestId, method: req.method, path: pathname, ip, userId });

  // Propagate requestId so route handlers can correlate logs.
  const headers = new Headers(req.headers);
  headers.set("x-request-id", requestId);
  const next = () => NextResponse.next({ request: { headers } });

  if (ALWAYS_ALLOW.test(pathname)) {
    logRequest();
    return next();
  }

  // API routes authenticate and authorize themselves (getSessionUser → 401
  // JSON). The middleware only guards PAGE navigations, where it can redirect
  // the browser to the sign-in screen.
  if (pathname.startsWith("/api/")) {
    logRequest();
    return next();
  }

  // One session system for every deployment: NextAuth's. A contributed provider's sign-in
  // ends in a NextAuth session too, so this file never has to know which kind of
  // deployment it is guarding.
  //
  // The wrapper resolved this before the handler ran, so there is nothing here that can
  // throw and swallow the request line — no try/catch needed around a plain field read.
  const session = req.auth;
  logRequest(session?.user?.id);

  // Authentication: every page except the public landing requires a signed-in
  // user. Bounce anonymous visitors to the sign-in screen and return them here
  // afterward (so e.g. a shared /ltool/<slug> link survives the round-trip).
  if (!session?.user) {
    if (pathname === "/") return next(); // landing renders its own sign-in prompt
    const back = req.nextUrl.pathname + req.nextUrl.search;
    // A provider JWT means the browser probably still has a renewable provider session.
    // Send that case to an honest spinner rather than flashing an interactive login form.
    // This is intentionally only a presence hint; verifier failures remain indistinguishable.
    const destination = shouldUseReauth(
      hostedIntegration() !== null,
      requestHasCookie(req, STYTCH_SESSION_COOKIE),
    )
      ? reauthPath(back)
      : signInPath(back);
    return NextResponse.redirect(new URL(destination, req.url));
  }

  // No authorization here — only authentication. Membership lives in the users
  // row (status/role, src/lib/authorize.ts) and this middleware performs no
  // database read, so it decodes the session and lets routes do the refusing:
  // every API route and page goes through getSessionUser(), which re-reads the
  // row and refuses a pending or disabled user on that request. The env-var
  // allow-list that used to be enforced here was retired as policy — it keyed
  // on the session's email, which an integration-owned sign-in may not carry
  // at all, so it refused exactly the people the deployment's own identity
  // provider had just admitted.
  return next();
});

export default async function proxy(req: NextRequest, event: NextFetchEvent) {
  const renewSession = hostedIntegration()?.renewSession;
  if (renewSession && renewalApplies(req.method, req.nextUrl.pathname)) {
    try {
      await renewAppSessionInPlace(req, renewSession);
    } catch (error) {
      // Ordinary page navigation must retain the existing redirect fallback even when
      // minting, verification, JWKS access, or the local user read fails.
      logger.warn("hosted session renewal pre-pass failed; falling back to sign-in", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return handleAuth(req, event);
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
