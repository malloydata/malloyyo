// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// One HMAC-signed, base64url-encoded, expiring JSON blob. Both consent steps —
// the authorization-code consent (authz-blob.ts) and the device approval
// (device-csrf.ts) — carry state through the browser this way, so both should
// agree on the secret, the encoding, and the comparison. Keeping the primitive
// here means a change to any of those reaches both at once.

import { createHmac, timingSafeEqual } from "node:crypto";

/** How long a signed blob stays valid. Long enough to sign in and read a
    consent screen, or to read a code off one screen and type it into another. */
export const SIGNING_TTL_SEC = 600;

function getSecret(): Buffer {
  const secret =
    process.env.OAUTH_SIGNING_SECRET ??
    process.env.AUTH_SECRET ??
    process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET must be set for OAuth flows");
  return Buffer.from(secret, "utf8");
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function fromB64url(s: string): Buffer {
  const padded = s
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(s.length + ((4 - (s.length % 4)) % 4), "=");
  return Buffer.from(padded, "base64");
}

/** Sign `payload` with an `exp` SIGNING_TTL_SEC from now. */
export function signBlob<T extends object>(payload: T): string {
  const full = { ...payload, exp: Math.floor(Date.now() / 1000) + SIGNING_TTL_SEC };
  const body = b64url(Buffer.from(JSON.stringify(full), "utf8"));
  const mac = createHmac("sha256", getSecret()).update(body).digest();
  return `${body}.${b64url(mac)}`;
}

/** The payload if the MAC verifies and `exp` is in the future, else null. Never
    throws on malformed input — a garbage token is an ordinary rejection. The
    caller validates the payload's own fields; this only proves it was ours. */
export function verifyBlob<T extends object>(token: string): (T & { exp: number }) | null {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", getSecret()).update(body).digest();
  let received: Buffer;
  try { received = fromB64url(sig); } catch { return null; }
  if (received.length !== expected.length) return null;
  if (!timingSafeEqual(received, expected)) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(fromB64url(body).toString("utf8")); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const exp = (parsed as { exp?: unknown }).exp;
  if (typeof exp !== "number" || exp < Math.floor(Date.now() / 1000)) return null;
  return parsed as T & { exp: number };
}
