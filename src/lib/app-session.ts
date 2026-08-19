// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Mint and inject the one application session Auth.js reads.
//
// The hosted integration verifies and identifies a person; this module owns the separate
// concern of signing Malloyyo's Auth.js JWT. Keeping AUTH_SECRET, the cookie derivation,
// and Auth.js's token shape here preserves that boundary and gives proxy.ts a valid token
// as input before the auth() wrapper computes its session response.

import { encode } from "next-auth/jwt";
import type { HostedAuthIntegration, HostedUser } from "./hosted-auth";

export const APP_SESSION_MAX_AGE_SECONDS = 60 * 60;

type CookiePair = { name: string; value: string };

function cookiePairs(request: Request): CookiePair[] {
  const header = request.headers.get("cookie");
  if (!header) return [];

  const pairs: CookiePair[] = [];
  for (const raw of header.split(";")) {
    const separator = raw.indexOf("=");
    if (separator < 0) continue;
    pairs.push({
      name: raw.slice(0, separator).trim(),
      value: raw.slice(separator + 1).trim(),
    });
  }
  return pairs;
}

/** Exact cookie-name check; similarly named cookies never satisfy it. */
export function requestHasCookie(request: Request, name: string): boolean {
  return cookiePairs(request).some((cookie) => cookie.name === name);
}

/**
 * Auth.js's request-specific default session-cookie name.
 *
 * Exact contract pin: @auth/core/lib/utils/env.js createActionURL honours AUTH_URL first
 * and otherwise defaults the inferred protocol to https; lib/init.js then passes
 * `url.protocol === "https:"` to defaultCookies in lib/utils/cookie.js.
 */
export function sessionCookieName(request: Request): string {
  const configuredUrl = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL;
  const detectedProtocol = configuredUrl
    ? new URL(configuredUrl).protocol
    : request.headers.get("x-forwarded-proto") ?? "https";
  const protocol = detectedProtocol.endsWith(":")
    ? detectedProtocol
    : `${detectedProtocol}:`;
  return `${protocol === "https:" ? "__Secure-" : ""}authjs.session-token`;
}

function authSecret(): string {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is required to renew the application session");
  return secret;
}

/** Mint exactly the token a successful credentials callback gives Auth.js. */
export async function mintSessionCookie(
  user: HostedUser,
  request: Request,
): Promise<{ name: string; value: string }> {
  const name = sessionCookieName(request);
  const value = await encode({
    token: {
      name: user.name,
      email: user.email,
      picture: user.image,
      sub: user.id,
    },
    secret: authSecret(),
    // Auth.js uses its session cookie name as the JWT salt. A token signed under the
    // wrong name fails silently and sends the visitor straight back through renewal.
    salt: name,
    maxAge: APP_SESSION_MAX_AGE_SECONDS,
  });
  return { name, value };
}

type RenewSession = NonNullable<HostedAuthIntegration["renewSession"]>;

/**
 * Verify through the integration, mint through the application, and mutate request input.
 *
 * Auth.js's wrapper reads `request.headers` only after this returns. Supplying the token
 * there lets the wrapper populate req.auth and rotate the cookie itself; setting a response
 * cookie here would be overwritten by the wrapper's invalid-session clearing cookie.
 */
export async function renewAppSessionInPlace(
  request: Request,
  renewSession: RenewSession,
): Promise<boolean> {
  const name = sessionCookieName(request);
  if (requestHasCookie(request, name)) return false;

  const user = await renewSession(request);
  if (!user) return false;

  const minted = await mintSessionCookie(user, request);
  const chunkName = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d+$`);
  const remaining = cookiePairs(request).filter((cookie) => !chunkName.test(cookie.name));
  remaining.push(minted);
  request.headers.set(
    "cookie",
    remaining.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
  );
  return true;
}
