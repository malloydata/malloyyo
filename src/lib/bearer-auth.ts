// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// One place that turns an `Authorization: Bearer …` header into a person, for
// every surface that accepts one: /mcp, and the CLI's publish + status routes.
//
// Two kinds of credential arrive here, and the difference is deliberate:
//
//   • An OAuth access token from `malloyyo login` (or a claude.ai connection).
//     Interactive, 24h, refreshable — and scoped by what the client asked for
//     on the consent screen. `malloyyo login` asks for "mcp publish"; a
//     claude.ai connection asks for "mcp" and so cannot publish, which is the
//     point: a credential delegated to a third party for querying must not
//     also be able to overwrite a model.
//   • A personal API token minted in the UI (src/lib/api-tokens.ts). Long-lived
//     and unattended, so it carries only the scopes its owner ticked.
//
// Both are re-authorized against the freshly-read user row on every request,
// which is what makes revoking a person — or a token — take effect now rather
// than at expiry.

import { eq } from "drizzle-orm";
import { db, users, type ApiToken, type ApiTokenScope, type User } from "@/db";
import { authorize } from "@/lib/authorize";
import {
  looksLikeApiToken,
  recordApiTokenUse,
  scopeSatisfied,
  validateApiToken,
  type RequiredScope,
} from "@/lib/api-tokens";
import { recordAccessTokenUse, validateAccessToken } from "@/lib/oauth/tokens";
import { grantedScopes } from "@/lib/api-token-scopes";

export type Credential =
  | { kind: "oauth"; clientId: string; scopes: ApiTokenScope[] }
  | { kind: "api-token"; token: ApiToken; scopes: ApiTokenScope[] };

export type BearerAuthResult =
  | { ok: true; user: User; cred: Credential }
  | { ok: false; status: 401 | 403; error: string };

/** Bearer token from the Authorization header, or "" when absent/not Bearer. */
export function bearerToken(req: Request): string {
  const header = req.headers.get("authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) return "";
  return header.slice(7).trim();
}

/** How a credential appears in a log line or a provenance field. Never the secret. */
export function credentialLabel(cred: Credential): string {
  return cred.kind === "oauth" ? `oauth:${cred.clientId}` : `token:${cred.token.name}`;
}

export interface BearerOptions {
  /** Which surface is being reached. An API token must carry this scope. */
  scope: RequiredScope;
  /** Whether to stamp last-used on the credential. Off for pure log lookups. */
  recordUse?: boolean;
}

/**
 * Resolve a raw bearer token: credential → user row → authorization → scope.
 * The order matters — "your account was disabled" and "this token can't do
 * that" are different answers, and neither should read as "bad token".
 */
export async function resolveBearer(raw: string, opts: BearerOptions): Promise<BearerAuthResult> {
  if (!raw) return { ok: false, status: 401, error: "missing bearer token" };

  let cred: Credential;
  let userId: string;
  let onUse: (() => void) | undefined;

  if (looksLikeApiToken(raw)) {
    const validated = await validateApiToken(raw);
    if (!validated.ok) {
      const hint = validated.hint ? ` — ${validated.hint}` : "";
      return { ok: false, status: 401, error: `invalid or revoked token${hint}` };
    }
    const token = validated.token;
    cred = { kind: "api-token", token, scopes: token.scopes };
    userId = token.userId;
    onUse = () => void recordApiTokenUse(token.id);
  } else {
    const validated = await validateAccessToken(raw);
    if (!validated.ok) return { ok: false, status: 401, error: "invalid or revoked token" };
    // grantedScopes reads the stored string conservatively: a grant from
    // before publishing had a scope of its own says "mcp", and stays MCP-only.
    cred = { kind: "oauth", clientId: validated.clientId, scopes: grantedScopes(validated.scope) };
    userId = validated.userId;
    onUse = () => void recordAccessTokenUse(validated.tokenHash);
  }

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return { ok: false, status: 401, error: "token user not found" };

  // The same per-request authorization the session and MCP paths use: a
  // disabled user's token stops working now, not at expiry.
  if (!authorize(user).allowed) {
    return { ok: false, status: 403, error: "access revoked for this account" };
  }

  if (!scopeSatisfied(cred.scopes, opts.scope)) {
    return {
      ok: false,
      status: 403,
      error:
        `this credential does not carry the "${opts.scope}" scope ` +
        `(it has: ${cred.scopes.join(", ") || "none"})`,
    };
  }

  if (opts.recordUse !== false) onUse?.();
  return { ok: true, user, cred };
}

/** resolveBearer() straight from a Request. */
export async function requireBearer(req: Request, opts: BearerOptions): Promise<BearerAuthResult> {
  return resolveBearer(bearerToken(req), opts);
}
