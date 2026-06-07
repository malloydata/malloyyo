// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { createHmac, timingSafeEqual } from "node:crypto";

export interface PendingAuthz {
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  resource: string | null;
  state: string | null;
  exp: number;
}

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

export function signAuthz(payload: Omit<PendingAuthz, "exp">): string {
  const full: PendingAuthz = { ...payload, exp: Math.floor(Date.now() / 1000) + SIGNING_TTL_SEC };
  const body = b64url(Buffer.from(JSON.stringify(full), "utf8"));
  const mac = createHmac("sha256", getSecret()).update(body).digest();
  return `${body}.${b64url(mac)}`;
}

export function verifyAuthz(token: string): PendingAuthz | null {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", getSecret()).update(body).digest();
  let received: Buffer;
  try { received = fromB64url(sig); } catch { return null; }
  if (received.length !== expected.length) return null;
  if (!timingSafeEqual(received, expected)) return null;
  let parsed: PendingAuthz;
  try { parsed = JSON.parse(fromB64url(body).toString("utf8")); } catch { return null; }
  if (typeof parsed.exp !== "number" || parsed.exp < Math.floor(Date.now() / 1000)) return null;
  return parsed;
}
