// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// RFC 8628 device authorization grant. Mirrors codes.ts — codes hashed at rest,
// one-time exchange, short TTL — with the two differences the flow requires:
// there is no redirect (so no PKCE; see below), and a second, human-typed code.

import { createHash, randomBytes, randomInt } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, oauthDeviceCodes } from "@/db";

/** The grant type identifier, used by /token, /device_authorization, discovery,
    and the client's dynamic registration. One constant so they cannot drift. */
export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = "23505";

const DEVICE_CODE_BYTES = 32;
/** 10 minutes: long enough to read a code off one screen and type it into another. */
export const DEVICE_CODE_TTL_SEC = 600;
/** Advertised minimum seconds between polls. Polling faster earns slow_down. */
export const DEVICE_POLL_INTERVAL_SEC = 5;
/** No vowels, so a code can never spell a word; no 0/O/1/I, which people
    mistype off a screen. Only ~34 bits of entropy, which is why device/decide
    rate-limits the caller rather than trusting the code's size. */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_LEN = 8;

export function hashCode(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** `BCDF-GHJK`. The dash is presentational — normalizeUserCode strips it. */
function generateUserCode(): string {
  let out = "";
  for (let i = 0; i < USER_CODE_LEN; i++) {
    out += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** Accept what a human actually types: any case, spaces, dashes, or none. */
export function normalizeUserCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export interface IssuedDeviceCode {
  deviceCode: string;
  userCode: string;
  expiresIn: number;
  interval: number;
}

export async function issueDeviceCode(params: {
  clientId: string;
  scope: string;
  resource: string | null;
}): Promise<IssuedDeviceCode> {
  const deviceCode = randomBytes(DEVICE_CODE_BYTES).toString("base64url");
  // Retry ONLY a user_code collision (Postgres 23505). Retrying anything else —
  // an FK violation from a bad clientId, a dropped connection — would do five
  // inserts and then surface the same error five times slower, with the cause
  // buried.
  for (let attempt = 0; attempt < 5; attempt++) {
    const userCode = generateUserCode();
    try {
      await db.insert(oauthDeviceCodes).values({
        deviceCodeHash: hashCode(deviceCode),
        userCodeHash: hashCode(normalizeUserCode(userCode)),
        clientId: params.clientId,
        scope: params.scope,
        resource: params.resource,
        expiresAt: new Date(Date.now() + DEVICE_CODE_TTL_SEC * 1000),
      });
      return {
        deviceCode,
        userCode,
        expiresIn: DEVICE_CODE_TTL_SEC,
        interval: DEVICE_POLL_INTERVAL_SEC,
      };
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      if (code !== UNIQUE_VIOLATION || attempt === 4) throw e;
    }
  }
  throw new Error("unreachable");
}

export type DeviceRow = typeof oauthDeviceCodes.$inferSelect;

/** A live (unexpired, undecided, unconsumed) flow for this user code. */
export async function findPendingByUserCode(rawUserCode: string): Promise<DeviceRow | null> {
  const [row] = await db
    .select()
    .from(oauthDeviceCodes)
    .where(
      and(
        eq(oauthDeviceCodes.userCodeHash, hashCode(normalizeUserCode(rawUserCode))),
        gt(oauthDeviceCodes.expiresAt, new Date()),
        isNull(oauthDeviceCodes.approvedAt),
        isNull(oauthDeviceCodes.deniedAt),
        isNull(oauthDeviceCodes.consumedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export type DecideResult = { ok: true } | { ok: false; reason: "not_found" };

/** Bind a signed-in user to a waiting flow, or deny it.

    Note what is NOT here: a per-flow attempt counter. A wrong guess cannot be
    attributed to any flow — we have no idea which one the guesser meant — so the
    only place a short code can be defended is the route, by rate-limiting the
    caller. See device/decide. */
export async function decideByUserCode(
  rawUserCode: string,
  userId: string,
  approve: boolean,
): Promise<DecideResult> {
  const row = await findPendingByUserCode(rawUserCode);
  if (!row) {
    return { ok: false, reason: "not_found" };
  }
  const now = new Date();
  await db
    .update(oauthDeviceCodes)
    .set(approve ? { userId, approvedAt: now } : { deniedAt: now })
    .where(eq(oauthDeviceCodes.deviceCodeHash, row.deviceCodeHash));
  return { ok: true };
}

export type PollResult =
  | { status: "approved"; row: DeviceRow }
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "not_found" };

/** What the token endpoint needs: the state of this flow, and — when approved —
    the row, atomically marked consumed so the exchange is one-time. */
export async function pollDeviceCode(rawDeviceCode: string, clientId: string): Promise<PollResult> {
  const hash = hashCode(rawDeviceCode);
  const [row] = await db
    .select()
    .from(oauthDeviceCodes)
    .where(eq(oauthDeviceCodes.deviceCodeHash, hash))
    .limit(1);
  if (!row || row.clientId !== clientId) return { status: "not_found" };
  if (row.consumedAt) return { status: "not_found" };
  if (row.deniedAt) return { status: "denied" };
  if (row.expiresAt <= new Date()) return { status: "expired" };

  const now = new Date();
  // Enforce the advertised interval. A second of slack keeps an honest client
  // polling exactly on the interval from tripping this.
  if (row.lastPolledAt && now.getTime() - row.lastPolledAt.getTime() < (DEVICE_POLL_INTERVAL_SEC - 1) * 1000) {
    return { status: "slow_down" };
  }
  await db
    .update(oauthDeviceCodes)
    .set({ lastPolledAt: now })
    .where(eq(oauthDeviceCodes.deviceCodeHash, hash));

  if (!row.approvedAt || !row.userId) return { status: "pending" };

  // One-time: the conditional update is the lock, so two simultaneous polls
  // cannot both mint tokens.
  const consumed = await db
    .update(oauthDeviceCodes)
    .set({ consumedAt: now })
    .where(and(eq(oauthDeviceCodes.deviceCodeHash, hash), isNull(oauthDeviceCodes.consumedAt)))
    .returning();
  if (consumed.length === 0) return { status: "not_found" };
  return { status: "approved", row };
}
