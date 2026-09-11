// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// CSRF protection for the device-flow approval step, following the same reasoning
// authz-blob.ts records for the authorization-code consent step.
//
// Why the device flow needs this MORE, not less. /api/oauth/device/decide is a
// cookie-authed POST, and the only other value in the request is the user_code —
// which the attacker KNOWS, because they started the flow. So without a token
// bound to the approving session, the sole barrier between an attacker and a
// token scoped to a victim is the session cookie's SameSite=Lax default, and
// authz-blob.ts already concluded that resting on it alone is not good enough.
//
// The elaborate "type the code yourself" defense on the approval page is worth
// nothing against a cross-site POST that skips the page entirely. This is what
// makes that defense real.
//
// Bound to the userId, and enforced on decide, so a blob lifted from one session
// cannot be replayed to approve something as a different user.

import { createHmac, timingSafeEqual } from "node:crypto";

export interface DeviceApproval {
  /** The session this approval form was rendered for. */
  userId: string;
  exp: number;
}

/** Long enough to read a code off one screen and type it into another, matching
    the device code's own lifetime — a form that outlived its code would only
    produce a confusing "not found". */
const SIGNING_TTL_SEC = 600;

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

export function signDeviceApproval(userId: string): string {
  const full: DeviceApproval = {
    userId,
    exp: Math.floor(Date.now() / 1000) + SIGNING_TTL_SEC,
  };
  const body = b64url(Buffer.from(JSON.stringify(full), "utf8"));
  const mac = createHmac("sha256", getSecret()).update(body).digest();
  return `${body}.${b64url(mac)}`;
}

export function verifyDeviceApproval(token: string): DeviceApproval | null {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", getSecret()).update(body).digest();
  let received: Buffer;
  try {
    received = fromB64url(sig);
  } catch {
    return null;
  }
  if (received.length !== expected.length) return null;
  if (!timingSafeEqual(received, expected)) return null;
  let parsed: DeviceApproval;
  try {
    parsed = JSON.parse(fromB64url(body).toString("utf8")) as DeviceApproval;
  } catch {
    return null;
  }
  if (typeof parsed.userId !== "string" || !parsed.userId) return null;
  if (typeof parsed.exp !== "number" || parsed.exp < Math.floor(Date.now() / 1000)) return null;
  return parsed;
}
