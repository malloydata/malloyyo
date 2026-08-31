// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { db, users, oauthAccessTokens, oauthRefreshTokens } from "@/db";
import { eq, and, isNull, gt } from "drizzle-orm";
import { isAdmin } from "@/lib/admin";
import { getSettings } from "@/lib/settings";
import { env } from "@/lib/env";
import { configuredAuthProviders, partialAuthProviders } from "@/lib/auth-providers";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
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
  try {
    u = await getSessionUser();
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) throw err;
    if (err.message === "pending" || err.message === "disabled") accessState = err.message;
  }

  if (!u) {
    // What the signed-out UI needs to render a sign-in, and nothing more.
    // `authMisconfigured` is a bare boolean — it never exposes which vars are
    // missing; the specifics go to the server logs (warnAuthConfig()).
    //
    // `hostedSignIn` is likewise a bare boolean. It used to be an object carrying the
    // integration's client configuration, which nothing ever read: the screens that need
    // that configuration are server-rendered and receive it directly. Serving it here only
    // published deployment details to unauthenticated callers for no one's benefit.
    return NextResponse.json({
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
  return NextResponse.json({
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
