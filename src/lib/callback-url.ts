// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * Reduce a `callbackUrl` to somewhere on this instance, or fall back to "/".
 *
 * A sign-in screen sends the browser wherever this says once a session exists, and the
 * value arrives in a query string anyone can write. Without this, a link to
 * `/login?callbackUrl=https://evil.example` would sign someone in and then hand them to an
 * attacker's page wearing this instance's name — the classic open redirect, and a
 * convincing one precisely because the sign-in that preceded it was genuine.
 *
 * Only a same-origin absolute path passes. Two shapes start with "/" and still leave the
 * origin, so both are rejected explicitly:
 *
 *   - `//evil.example` — protocol-relative, a URL for another host.
 *   - `/\evil.example` — browsers normalize the backslash to a slash while parsing the
 *     authority, so it behaves as the first one does.
 *
 * Lives in its own module, with no imports, so it can be tested without dragging NextAuth
 * and a database connection into the test process.
 */
export function safeCallbackUrl(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}
