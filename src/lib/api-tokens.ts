// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Personal API tokens — the credential behind `export MALLOYYO_TOKEN=…`.
//
// Everything above the "── database ──" line is pure, so the unit suite (no
// Postgres) can pin the parts that are easy to get subtly wrong: the wire
// format, what counts as a valid name, and how an expiry choice becomes a date.

import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db, apiTokens, type ApiToken } from "@/db";
import { API_TOKEN_SCOPES, normalizeScopes, type ApiTokenScope } from "@/lib/api-token-scopes";
import { env } from "@/lib/env";
import { logger, serializeErr } from "@/lib/logger";

/**
 * Tokens are `myo_<instance-code>_<43 chars of base64url>`.
 *
 * The `myo_` marker earns its keep three times over: the CLI can say "that
 * doesn't look like a Malloyyo token" instead of relaying a bare 401 when
 * MALLOYYO_TOKEN holds something else entirely (a warehouse secret, say);
 * secret scanners can match the pattern before the value reaches a public
 * repo; and logs can be swept for it. The instance code — the same one that
 * prefixes shareable slugs (src/lib/slug.ts) — turns "wrong instance" from a
 * mystery 401 into a sentence.
 */
export const API_TOKEN_MARKER = "myo";

/** Bytes of entropy in the secret tail. 32 → 43 base64url chars. */
const SECRET_BYTES = 32;

/**
 * How much of the value the UI may keep. Long enough to tell two tokens apart
 * in a list ("which one is in the CI variable?"), far too short to guess the
 * remaining ~200 bits from.
 */
const DISPLAY_CHARS = 8;

/** Per user. A cap so one compromised session can't mint an unbounded set. */
export const MAX_TOKENS_PER_USER = 20;

export const MAX_TOKEN_NAME_LENGTH = 64;

/** Upper bound on a bounded expiry — ten years. `null` (never) is separate. */
const MAX_EXPIRY_DAYS = 3650;

export interface MintedValue {
  /** The secret. Shown to its owner exactly once and never stored. */
  raw: string;
  hash: string;
  /** The head of `raw`, safe to store and display. */
  prefix: string;
}

/**
 * The instance code as it appears INSIDE a token. Stripped of anything that
 * isn't alphanumeric because the code sits between two underscores: an
 * operator who sets INSTANCE_CODE="east_1" would otherwise mint values that
 * parseApiToken() can't split back apart.
 */
export function tokenInstanceCode(): string {
  return env.INSTANCE_CODE.replace(/[^a-z0-9]/g, "") || "main";
}

export function mintTokenValue(): MintedValue {
  const raw = `${API_TOKEN_MARKER}_${tokenInstanceCode()}_${randomBytes(SECRET_BYTES).toString("base64url")}`;
  return { raw, hash: hashApiToken(raw), prefix: displayPrefix(raw) };
}

export function hashApiToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** `myo_stg_a1b2c3d4` — the marker, the instance code, and a recognizable head. */
export function displayPrefix(raw: string): string {
  const parsed = parseApiToken(raw);
  if (!parsed) return raw.slice(0, DISPLAY_CHARS);
  return `${API_TOKEN_MARKER}_${parsed.code}_${parsed.secret.slice(0, DISPLAY_CHARS)}`;
}

/**
 * Is this value shaped like one of our tokens? Used to route a bearer token to
 * the right table — an OAuth access token from `malloyyo login` is 43 chars of
 * base64url with no marker, so the two can never be confused.
 */
export function looksLikeApiToken(raw: string): boolean {
  return parseApiToken(raw) !== null;
}

/**
 * Split `myo_<code>_<secret>` apart. Deliberately NOT `split("_")`: base64url
 * includes `_`, so a perfectly good secret can contain underscores and a
 * three-part split would reject roughly one token in three.
 */
export function parseApiToken(
  raw: string,
): { code: string; secret: string; matchesInstance: boolean } | null {
  const afterMarker = `${API_TOKEN_MARKER}_`;
  if (!raw.startsWith(afterMarker)) return null;
  const rest = raw.slice(afterMarker.length);
  const split = rest.indexOf("_");
  if (split <= 0) return null;
  const code = rest.slice(0, split);
  const secret = rest.slice(split + 1);
  // The code is minted alphanumeric (tokenInstanceCode); anything else did not
  // come from here. A short tail likewise can't be one of ours.
  if (!/^[a-z0-9]+$/.test(code)) return null;
  if (secret.length < 20) return null;
  return { code, secret, matchesInstance: code === tokenInstanceCode() };
}

/** The scope a surface requires of whatever credential reached it. */
export type RequiredScope = ApiTokenScope;

export function scopeSatisfied(granted: ApiTokenScope[], want: RequiredScope): boolean {
  return granted.includes(want);
}

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

export function validateTokenName(input: unknown): Validated<string> {
  if (typeof input !== "string") return { ok: false, error: "name is required" };
  const name = input.trim();
  if (!name) return { ok: false, error: "name is required" };
  if (name.length > MAX_TOKEN_NAME_LENGTH) {
    return { ok: false, error: `name must be ${MAX_TOKEN_NAME_LENGTH} characters or fewer` };
  }
  return { ok: true, value: name };
}

export function validateScopes(input: unknown): Validated<ApiTokenScope[]> {
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, error: `pick at least one scope (${API_TOKEN_SCOPES.join(", ")})` };
  }
  const out: ApiTokenScope[] = [];
  for (const s of input) {
    if (typeof s !== "string" || !(API_TOKEN_SCOPES as readonly string[]).includes(s)) {
      return { ok: false, error: `unknown scope "${String(s)}"` };
    }
    if (!out.includes(s as ApiTokenScope)) out.push(s as ApiTokenScope);
  }
  // Stable order, so the stored array reads the same however the form sent it.
  return { ok: true, value: normalizeScopes(out) };
}

/**
 * `expiresInDays` → an absolute instant. `null` is "never expires", which the
 * UI offers deliberately: unattended credentials that lapse on their own break
 * a pipeline at the worst possible moment, and a revoke button plus a visible
 * last-used column is the better control.
 */
export function expiryFromDays(input: unknown, now = new Date()): Validated<Date | null> {
  if (input === null || input === undefined) return { ok: true, value: null };
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return { ok: false, error: "expiresInDays must be a number of days, or null for never" };
  }
  if (!Number.isInteger(input) || input < 1 || input > MAX_EXPIRY_DAYS) {
    return { ok: false, error: `expiresInDays must be between 1 and ${MAX_EXPIRY_DAYS}, or null` };
  }
  return { ok: true, value: new Date(now.getTime() + input * 24 * 60 * 60 * 1000) };
}

export function isExpired(token: Pick<ApiToken, "expiresAt">, now = new Date()): boolean {
  return token.expiresAt !== null && token.expiresAt.getTime() < now.getTime();
}

/** What the UI shows for one token. Never carries the secret. */
export interface ApiTokenView {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiTokenScope[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  expired: boolean;
}

export function toView(row: ApiToken, now = new Date()): ApiTokenView {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expired: isExpired(row, now),
  };
}

// ── database ────────────────────────────────────────────────────────────────

export interface CreateParams {
  userId: string;
  name: string;
  scopes: ApiTokenScope[];
  expiresAt: Date | null;
}

export type CreateResult =
  | { ok: true; token: ApiToken; raw: string }
  | { ok: false; error: string };

export async function createApiToken(params: CreateParams): Promise<CreateResult> {
  // Expired rows still show in the list (so nobody wonders where one went) but
  // they are not live, and counting them would refuse a new token to someone
  // whose twenty are all dead.
  const live = (await listApiTokens(params.userId)).filter((t) => !isExpired(t));
  if (live.length >= MAX_TOKENS_PER_USER) {
    return {
      ok: false,
      error:
        `you already have ${MAX_TOKENS_PER_USER} live tokens — ` +
        `revoke one before creating another`,
    };
  }
  const minted = mintTokenValue();
  const [row] = await db
    .insert(apiTokens)
    .values({
      userId: params.userId,
      name: params.name,
      tokenHash: minted.hash,
      prefix: minted.prefix,
      scopes: params.scopes,
      expiresAt: params.expiresAt,
    })
    .returning();
  return { ok: true, token: row, raw: minted.raw };
}

/** This user's un-revoked tokens, newest first. Expired ones are included —
    they are still listed (and still revocable) so nobody wonders where one went. */
export async function listApiTokens(userId: string): Promise<ApiToken[]> {
  return db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
    .orderBy(desc(apiTokens.createdAt));
}

/** Revoke one of this user's tokens. Scoped by userId so an id alone is not a key. */
export async function revokeApiToken(userId: string, id: string): Promise<boolean> {
  const revoked = await db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
    .returning({ id: apiTokens.id });
  return revoked.length > 0;
}

export type ApiTokenValidation =
  | { ok: true; token: ApiToken }
  | { ok: false; reason: "malformed" | "not_found" | "revoked" | "expired"; hint?: string };

/**
 * Resolve a raw token to its row. Revocation and expiry are checked here, so
 * both take effect on the very next request — nothing is cached.
 */
export async function validateApiToken(raw: string): Promise<ApiTokenValidation> {
  const parsed = parseApiToken(raw);
  if (!parsed) return { ok: false, reason: "malformed" };

  const [row] = await db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.tokenHash, hashApiToken(raw)))
    .limit(1);
  if (!row) {
    // A token minted on a sibling deployment is the likeliest reason a
    // well-formed value isn't here; say so rather than leaving someone to
    // re-mint tokens against the wrong instance.
    return {
      ok: false,
      reason: "not_found",
      hint: parsed.matchesInstance
        ? undefined
        : `that token was minted on "${parsed.code}"; this instance is "${tokenInstanceCode()}"`,
    };
  }
  if (row.revokedAt) return { ok: false, reason: "revoked" };
  if (isExpired(row)) return { ok: false, reason: "expired" };
  return { ok: true, token: row };
}

export async function recordApiTokenUse(id: string): Promise<void> {
  try {
    await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, id));
  } catch (err) {
    logger.warn("recordApiTokenUse failed", { ...serializeErr(err) });
  }
}
