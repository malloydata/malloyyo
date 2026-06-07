// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, oauthAuthorizationCodes } from "@/db";

const CODE_BYTES = 32;
const CODE_TTL_SEC = 60;

export function hashCode(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function generateCode(): { raw: string; hash: string } {
  const raw = randomBytes(CODE_BYTES).toString("base64url");
  return { raw, hash: hashCode(raw) };
}

export interface IssuedCodeParams {
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  resource: string | null;
}

export async function issueAuthorizationCode(params: IssuedCodeParams): Promise<string> {
  const { raw, hash } = generateCode();
  await db.insert(oauthAuthorizationCodes).values({
    codeHash: hash,
    clientId: params.clientId,
    userId: params.userId,
    redirectUri: params.redirectUri,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: params.codeChallengeMethod,
    scope: params.scope,
    resource: params.resource,
    expiresAt: new Date(Date.now() + CODE_TTL_SEC * 1000),
  });
  return raw;
}

export function verifyPkce(codeChallenge: string, codeChallengeMethod: string, codeVerifier: string): boolean {
  if (codeChallengeMethod !== "S256") return false;
  const computed = createHash("sha256").update(codeVerifier).digest("base64url");
  return computed === codeChallenge;
}

export type ConsumeResult =
  | { ok: true; row: typeof oauthAuthorizationCodes.$inferSelect }
  | { ok: false; reason: "not_found" | "expired" | "already_used" };

export async function consumeAuthorizationCode(rawCode: string): Promise<ConsumeResult> {
  const hash = hashCode(rawCode);
  const now = new Date();
  const updated = await db
    .update(oauthAuthorizationCodes)
    .set({ consumedAt: now })
    .where(and(
      eq(oauthAuthorizationCodes.codeHash, hash),
      isNull(oauthAuthorizationCodes.consumedAt),
      gt(oauthAuthorizationCodes.expiresAt, now),
    ))
    .returning();
  if (updated[0]) return { ok: true, row: updated[0] };
  const existing = await db.select().from(oauthAuthorizationCodes).where(eq(oauthAuthorizationCodes.codeHash, hash)).limit(1);
  const row = existing[0];
  if (!row) return { ok: false, reason: "not_found" };
  if (row.consumedAt) return { ok: false, reason: "already_used" };
  return { ok: false, reason: "expired" };
}
