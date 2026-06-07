// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db, users, oauthAccessTokens, oauthRefreshTokens } from "@/db";
import { eq, and, isNull, gt } from "drizzle-orm";
import { isAdmin } from "@/lib/admin";
import { env } from "@/lib/env";

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
  if (!session?.user?.id) return NextResponse.json({ user: null, instanceName: env.INSTANCE_NAME });
  const [u] = await db.select().from(users).where(eq(users.id, session.user.id));
  const claudeConnected = u ? await hasActiveClaudeConnection(u.id) : false;
  return NextResponse.json({
    instanceName: env.INSTANCE_NAME,
    claudeConnected,
    user: u
      ? { id: u.id, name: u.name, email: u.email, image: u.image, slug: u.slug, isAdmin: isAdmin(u) }
      : null,
  });
}
