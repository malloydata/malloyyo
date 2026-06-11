// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { eq } from "drizzle-orm";
import { db, users, type User } from "@/db";
import { isAdmin } from "@/lib/admin";
import { recordAccessTokenUse, validateAccessToken } from "@/lib/oauth/tokens";

export type BearerAuthResult =
  | { ok: true; user: User }
  | { ok: false; status: 401 | 403; error: string };

/**
 * Resolve an OAuth bearer token from the Authorization header to a user, and
 * require that user be an admin. Used by the malloyyo-CLI endpoints.
 *
 * Authorization is admin-only for now (matches the model/github route); owner-based
 * publishing is a documented future loosening (docs/model-publishing-design.md §4.5).
 */
export async function requireAdminBearer(req: Request): Promise<BearerAuthResult> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    return { ok: false, status: 401, error: "missing bearer token" };
  }
  const raw = authHeader.slice(7).trim();
  const validated = await validateAccessToken(raw);
  if (!validated.ok) return { ok: false, status: 401, error: "invalid or revoked token" };

  const [user] = await db.select().from(users).where(eq(users.id, validated.userId)).limit(1);
  if (!user) return { ok: false, status: 401, error: "token user not found" };

  void recordAccessTokenUse(validated.tokenHash);

  if (!isAdmin(user)) return { ok: false, status: 403, error: "admin required" };
  return { ok: true, user };
}
