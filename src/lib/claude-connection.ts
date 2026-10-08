// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { db, oauthAccessTokens, oauthRefreshTokens, oauthClients } from "@/db";
import { eq, and, isNull, gt } from "drizzle-orm";
import { isClaudeAiClient } from "@/lib/claude-client";

// Has this user connected claude.ai to this instance — completed the MCP OAuth
// flow FROM claude.ai (web, Desktop and mobile share the one connector and the
// one callback) and still holding a live token? Decides whether the "Explore in
// Claude" buttons open a seeded chat or show connection setup first. Grants
// from other clients don't count: the malloyyo CLI's login and Claude Code use
// the same OAuth tables, and a user with only those has no connector in
// claude.ai, so a seeded chat there finds no tools. See isClaudeAiClient.
export async function hasActiveClaudeConnection(userId: string): Promise<boolean> {
  const now = new Date();
  const live = await db
    .selectDistinct({ redirectUris: oauthClients.redirectUris })
    .from(oauthAccessTokens)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthAccessTokens.clientId))
    .where(and(eq(oauthAccessTokens.userId, userId), isNull(oauthAccessTokens.revokedAt), gt(oauthAccessTokens.expiresAt, now)));
  if (live.some((c) => isClaudeAiClient(c.redirectUris))) return true;
  const refreshable = await db
    .selectDistinct({ redirectUris: oauthClients.redirectUris })
    .from(oauthRefreshTokens)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthRefreshTokens.clientId))
    .where(and(eq(oauthRefreshTokens.userId, userId), isNull(oauthRefreshTokens.revokedAt), gt(oauthRefreshTokens.expiresAt, now)));
  return refreshable.some((c) => isClaudeAiClient(c.redirectUris));
}
