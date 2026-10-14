// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { db, oauthAccessTokens, oauthRefreshTokens, oauthClients } from "@/db";
import { eq, and, isNull, gt } from "drizzle-orm";
import { isClaudeAiClient } from "@/lib/claude-client";

// Has this user connected claude.ai (not just the CLI or Claude Code, which use
// the same OAuth tables) and still holds a live token? Picks whether the Claude
// buttons open a seeded chat or the connect dialog. See isClaudeAiClient.
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
