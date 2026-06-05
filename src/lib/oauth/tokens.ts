import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db, oauthAccessTokens, oauthRefreshTokens } from "@/db";
import { logger } from "@/lib/logger";

export const ACCESS_TTL_SEC = 24 * 60 * 60;
export const REFRESH_TTL_SEC = 90 * 24 * 60 * 60;

function generateToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface IssueParams {
  clientId: string;
  userId: string;
  scope: string;
  resource: string | null;
}

export async function issueTokenPair(params: IssueParams): Promise<IssuedTokens> {
  const access = generateToken();
  const refresh = generateToken();
  const now = Date.now();
  await db.insert(oauthAccessTokens).values({
    tokenHash: access.hash,
    clientId: params.clientId,
    userId: params.userId,
    scope: params.scope,
    resource: params.resource,
    expiresAt: new Date(now + ACCESS_TTL_SEC * 1000),
  });
  await db.insert(oauthRefreshTokens).values({
    tokenHash: refresh.hash,
    clientId: params.clientId,
    userId: params.userId,
    scope: params.scope,
    resource: params.resource,
    expiresAt: new Date(now + REFRESH_TTL_SEC * 1000),
  });
  return { accessToken: access.raw, refreshToken: refresh.raw, expiresIn: ACCESS_TTL_SEC };
}

export type RotateResult =
  | { ok: true; tokens: IssuedTokens; clientId: string }
  | { ok: false; reason: "not_found" | "revoked" | "expired" | "replayed" };

export async function rotateRefreshToken(rawToken: string, presentedClientId: string): Promise<RotateResult> {
  const tokenHash = hashToken(rawToken);
  const peek = await db.select().from(oauthRefreshTokens).where(eq(oauthRefreshTokens.tokenHash, tokenHash)).limit(1);
  const old = peek[0];
  if (!old) return { ok: false, reason: "not_found" };
  if (old.clientId !== presentedClientId) return { ok: false, reason: "not_found" };

  if (old.replacedById) {
    const now = new Date();
    await db.update(oauthRefreshTokens).set({ revokedAt: now })
      .where(and(eq(oauthRefreshTokens.clientId, old.clientId), eq(oauthRefreshTokens.userId, old.userId), isNull(oauthRefreshTokens.revokedAt)));
    await db.update(oauthAccessTokens).set({ revokedAt: now })
      .where(and(eq(oauthAccessTokens.clientId, old.clientId), eq(oauthAccessTokens.userId, old.userId), isNull(oauthAccessTokens.revokedAt)));
    return { ok: false, reason: "replayed" };
  }

  if (old.revokedAt) return { ok: false, reason: "revoked" };
  if (old.expiresAt.getTime() < Date.now()) return { ok: false, reason: "expired" };

  const newAccess = generateToken();
  const newRefresh = generateToken();
  const newRefreshId = randomUUID();
  const now = new Date();

  const claimed = await db.update(oauthRefreshTokens)
    .set({ replacedById: newRefreshId, revokedAt: now })
    .where(and(eq(oauthRefreshTokens.id, old.id), isNull(oauthRefreshTokens.replacedById), isNull(oauthRefreshTokens.revokedAt)))
    .returning();
  if (!claimed[0]) return { ok: false, reason: "not_found" };

  await db.insert(oauthAccessTokens).values({
    tokenHash: newAccess.hash, clientId: old.clientId, userId: old.userId,
    scope: old.scope, resource: old.resource, expiresAt: new Date(now.getTime() + ACCESS_TTL_SEC * 1000),
  });
  await db.insert(oauthRefreshTokens).values({
    id: newRefreshId, tokenHash: newRefresh.hash, clientId: old.clientId, userId: old.userId,
    scope: old.scope, resource: old.resource, expiresAt: new Date(now.getTime() + REFRESH_TTL_SEC * 1000),
  });

  return { ok: true, clientId: old.clientId, tokens: { accessToken: newAccess.raw, refreshToken: newRefresh.raw, expiresIn: ACCESS_TTL_SEC } };
}

export type AccessValidationResult =
  | { ok: true; userId: string; clientId: string; scope: string; tokenHash: string }
  | { ok: false; reason: "malformed" | "not_found" | "revoked" | "expired" };

export async function validateAccessToken(rawToken: string): Promise<AccessValidationResult> {
  if (!rawToken) return { ok: false, reason: "malformed" };
  const tokenHash = hashToken(rawToken);
  const rows = await db.select().from(oauthAccessTokens).where(eq(oauthAccessTokens.tokenHash, tokenHash)).limit(1);
  const row = rows[0];
  if (!row) return { ok: false, reason: "not_found" };
  if (row.revokedAt) return { ok: false, reason: "revoked" };
  if (row.expiresAt.getTime() < Date.now()) return { ok: false, reason: "expired" };
  return { ok: true, userId: row.userId, clientId: row.clientId, scope: row.scope, tokenHash };
}

export async function recordAccessTokenUse(tokenHash: string): Promise<void> {
  try {
    await db.update(oauthAccessTokens).set({ lastUsedAt: new Date() }).where(eq(oauthAccessTokens.tokenHash, tokenHash));
  } catch (err) {
    logger.warn("recordAccessTokenUse failed", { err: err instanceof Error ? err.message : String(err) });
  }
}
