// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The value of the impersonation cookie: who is being viewed as, by whom, since
// when — signed.
//
// It used to be the bare uuid of the person being viewed as. The rules it was
// meant to carry were then true only of a browser that behaved:
//
//   - "It ends after an hour" was the cookie's max-age. An admin who set the
//     cookie by hand, or kept it, was impersonating until they stopped.
//   - "It is logged that you looked" was a line written by the start route. An
//     admin who set the cookie by hand never called it.
//   - It named a target and no admin, so it kept working for whichever admin
//     used that browser next.
//
// None of that let anyone do what they could not otherwise — only an admin's
// cookie is honoured at all, and an admin can start impersonating properly. But
// the hour and the record are the promises the banner makes to everyone else,
// and a promise only the honest path keeps is not one.
//
// So the cookie is minted by the start route (which is where the log line is
// written), names the admin it was minted for, and carries its own start time.
// `getSession()` verifies all three on every request; a value it cannot verify
// is ignored exactly as a missing one is.

import crypto from "node:crypto";
import { VIEW_AS_MAX_AGE_SECONDS } from "./view-as";

/** AUTH_SECRET is what signs the session this rides alongside, so an instance
    that can sign people in can do this. The dashboard key is the fallback for
    the deployments that key exists for (src/lib/dashboards/frame-token.ts). */
function secret(): string | null {
  return process.env.AUTH_SECRET ?? process.env.DASHBOARD_TOKEN_SECRET ?? null;
}

function sign(payload: string, key: string): string {
  // Domain-separated: the same secret signs other things, and a signature made
  // for one of them must not verify here.
  return crypto.createHmac("sha256", key).update(`view-as.v1:${payload}`).digest("base64url");
}

/** Mint the cookie value. Null when the instance has no signing secret, in
    which case impersonation is simply unavailable. */
export function mintViewAsToken(claims: { adminId: string; targetId: string }, now = Date.now()): string | null {
  const key = secret();
  if (!key) return null;
  const payload = Buffer.from(
    JSON.stringify({ a: claims.adminId, t: claims.targetId, iat: Math.floor(now / 1000) }),
  ).toString("base64url");
  return `${payload}.${sign(payload, key)}`;
}

/**
 * The id of the person `adminId` is impersonating, or null.
 *
 * Null for anything that is not a token this instance minted, for THIS admin,
 * within the last hour — a bare uuid, a token minted for someone else, one
 * past its hour, one from the future.
 */
export function verifyViewAsToken(token: string | undefined, adminId: string, now = Date.now()): string | null {
  const key = secret();
  if (!key || !token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(payload, key));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let claims: { a?: unknown; t?: unknown; iat?: unknown };
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof claims.a !== "string" || typeof claims.t !== "string" || typeof claims.iat !== "number") return null;
  if (claims.a !== adminId) return null;
  const age = Math.floor(now / 1000) - claims.iat;
  if (age < 0 || age > VIEW_AS_MAX_AGE_SECONDS) return null;
  return claims.t;
}
