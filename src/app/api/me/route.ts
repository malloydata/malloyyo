// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { VIEW_AS_COOKIE, VIEW_AS_MARKER_COOKIE } from "@/lib/view-as";
import { db, users, oauthAccessTokens, oauthRefreshTokens } from "@/db";
import { eq, and, isNull, gt } from "drizzle-orm";
import { isAdmin } from "@/lib/admin";
import { getSettings } from "@/lib/settings";
import { env } from "@/lib/env";
import { configuredAuthProviders, partialAuthProviders } from "@/lib/auth-providers";
import { getSession, UnauthorizedError } from "@/lib/user";
import { askConfig, askEnabled } from "@/lib/ask";
import { hostedSignIn } from "@/lib/hosted-auth-integration";
import { signInPath, signOutPath } from "@/lib/auth-paths";

export const runtime = "nodejs";

// Has this user ever completed the MCP OAuth flow and still holds a live
// token? Used by the ltool "Explore further with Claude" button to decide
// whether to show connection setup instructions first.
async function hasActiveClaudeConnection(userId: string): Promise<boolean> {
  const now = new Date();
  const [acc] = await db
    .select({ h: oauthAccessTokens.tokenHash })
    .from(oauthAccessTokens)
    .where(and(eq(oauthAccessTokens.userId, userId), isNull(oauthAccessTokens.revokedAt), gt(oauthAccessTokens.expiresAt, now)))
    .limit(1);
  if (acc) return true;
  const [ref] = await db
    .select({ id: oauthRefreshTokens.id })
    .from(oauthRefreshTokens)
    .where(and(eq(oauthRefreshTokens.userId, userId), isNull(oauthRefreshTokens.revokedAt), gt(oauthRefreshTokens.expiresAt, now)))
    .limit(1);
  return !!ref;
}

/**
 * The answer, with a view-as cookie that names no live view-as cleared.
 *
 * The cookie outlives what it stands for whenever a view-as ends without Stop:
 * the admin signs out, is demoted, or the person they were viewing is disabled.
 * It grants nothing then (`getSession()` ignores it) — but the proxy refuses
 * writes on the cookie alone (src/lib/view-as.ts), so one left behind would
 * lock whoever uses that browser next out of changing anything. The banner
 * calls this route on the first page load, which is where it is taken away.
 */
async function settled(viewingAs: boolean, body: Record<string, unknown>): Promise<NextResponse> {
  const res = NextResponse.json(body);
  if (viewingAs) return res;
  const jar = await cookies();
  if (jar.has(VIEW_AS_COOKIE) || jar.has(VIEW_AS_MARKER_COOKIE)) {
    res.cookies.set(VIEW_AS_COOKIE, "", { path: "/", maxAge: 0 });
    res.cookies.set(VIEW_AS_MARKER_COOKIE, "", { path: "/", maxAge: 0 });
  }
  return res;
}

export async function GET() {
  const { tagline, signinNotice } = await getSettings();

  // A managed deployment's sign-in is owned by an integration; an ordinary one uses
  // NextAuth, untouched. getSessionUser() picks, and on the managed path it also creates
  // the local row for someone arriving for the first time.
  const hosted = hostedSignIn();
  let u: typeof users.$inferSelect | undefined;
  // Someone signed in but not admitted: "pending" is waiting for approval,
  // "disabled" is revoked. getSessionUser throws the reason; the landing page
  // renders it instead of a sign-in button that would loop them straight back.
  let accessState: "pending" | "disabled" | undefined;
  let viewingAs = false;
  try {
    // One lookup for both answers: who this request acts as, and — while an
    // admin is viewing as them — that it is a view-as, for the banner.
    const session = await getSession();
    u = session.user;
    viewingAs = !!session.viewedBy;
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) throw err;
    if (err.message === "pending" || err.message === "disabled") accessState = err.message;
  }

  if (!u) {
    // (`settled`: see below — a signed-out browser may still carry the cookie.)
    // What the signed-out UI needs to render a sign-in, and nothing more.
    // `authMisconfigured` is a bare boolean — it never exposes which vars are
    // missing; the specifics go to the server logs (warnAuthConfig()).
    //
    // `hostedSignIn` is likewise a bare boolean. It used to be an object carrying the
    // integration's client configuration, which nothing ever read: the screens that need
    // that configuration are server-rendered and receive it directly. Serving it here only
    // published deployment details to unauthenticated callers for no one's benefit.
    return settled(false, {
      user: null,
      instanceName: env.INSTANCE_NAME,
      tagline,
      signinNotice,
      providers: hosted ? [] : configuredAuthProviders(),
      // Where to send someone, decided on the server. The UI used to re-derive this from
      // whether the integration's configuration was present, which was only true while
      // signed out — so the header's sign-out fell back to NextAuth's endpoint on a managed
      // deployment and landed on its configuration-error page. One owner, no duplicate.
      signInPath: signInPath("/"),
      signOutPath: signOutPath("/"),
      authMisconfigured: hosted ? false : partialAuthProviders().length > 0,
      hostedSignIn: hosted,
      ...(accessState ? { accessState } : {}),
    });
  }
  const claudeConnected = await hasActiveClaudeConnection(u.id);
  return settled(viewingAs, {
    // An admin viewing as someone: `u` is already THAT person, so the rest of
    // this answer is theirs. This says so, for the banner on every page.
    ...(viewingAs ? { viewingAs: { name: u.name, email: u.email } } : {}),
    instanceName: env.INSTANCE_NAME,
    tagline,
    signinNotice,
    claudeConnected,
    // Whether this deployment has an Anthropic key. Signed-in only: the shape
    // of an instance's paid integrations isn't something to publish to
    // unauthenticated callers, and only a signed-in page can use Ask anyway.
    askEnabled: askEnabled(),
    // Which model answers and at what effort — shown in the Ask box so nobody
    // has to read the deployment's env to know what is about to spend money on
    // their behalf.
    askConfig: askEnabled() ? askConfig() : null,
    signInPath: signInPath("/"),
    signOutPath: signOutPath("/"),
    user: { id: u.id, name: u.name, email: u.email, image: u.image, isAdmin: isAdmin(u) },
  });
}
