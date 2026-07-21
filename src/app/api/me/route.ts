// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db, users, oauthAccessTokens, oauthRefreshTokens } from "@/db";
import { eq, and, isNull, gt } from "drizzle-orm";
import { isAdmin } from "@/lib/admin";
import { getSettings } from "@/lib/settings";
import { env } from "@/lib/env";
import { configuredAuthProviders, partialAuthProviders } from "@/lib/auth-providers";

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
  const session = await auth();
  const { tagline, signinNotice } = await getSettings();
  const providers = configuredAuthProviders();
  // True when a provider is half-configured (some vars set, not all). Lets the
  // signed-out UI point the operator at the server logs instead of a dead page.
  // Only a boolean is exposed — never which vars are missing.
  const authMisconfigured = partialAuthProviders().length > 0;
  if (!session?.user?.id) return NextResponse.json({ user: null, instanceName: env.INSTANCE_NAME, tagline, signinNotice, providers, authMisconfigured });
  const [u] = await db.select().from(users).where(eq(users.id, session.user.id));
  const claudeConnected = u ? await hasActiveClaudeConnection(u.id) : false;
  return NextResponse.json({
    instanceName: env.INSTANCE_NAME,
    tagline,
    signinNotice,
    claudeConnected,
    user: u
      ? { id: u.id, name: u.name, email: u.email, image: u.image, slug: u.slug, isAdmin: isAdmin(u) }
      : null,
  });
}
