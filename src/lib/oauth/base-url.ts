// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The instance's own public origin, as it appears in everything we HAND OUT:
// the OAuth discovery documents (`issuer`, `authorization_endpoint`,
// `token_endpoint`), the `WWW-Authenticate: … resource_metadata="…"` header on
// /mcp 401s, the sign-in and consent redirects, and the `/ltool/<slug>` share
// links surfaced inside MCP clients.
//
// It must NOT be derived from `X-Forwarded-Host`. That header is chosen by the
// CALLER unless something upstream overwrites it, and nothing guarantees that:
// Vercel's edge does overwrite it (which is why deriving from it was safe here
// historically), but a container behind Fly, Railway, Coolify, or a hand-rolled
// nginx generally does not — and the committed Dockerfile means self-hosters
// run behind exactly those. A spoofed value hands a programmatic MCP client an
// attacker-controlled `authorization_endpoint`, and makes share links point at
// attacker infrastructure while looking like ours.
//
// So `APP_BASE_URL` wins whenever it is set. It is already documented as
// required for a container deploy — "the public URL the instance is served at;
// used for OAuth redirects" (docs/docker.md) — so this is the code finally
// honoring what the docs promise. The header-derived form stays only as the
// local-dev / dynamic-preview-hostname fallback.

/** `APP_BASE_URL` as a bare origin, or null when unset/blank/unparseable.

    Read from `process.env` directly, NOT via `env.APP_BASE_URL`: that getter
    defaults to `http://localhost:3000`, which would silently replace the
    request-derived fallback below with a localhost URL on any instance that
    hasn't set it. */
export function configuredOrigin(): string | null {
  const raw = process.env.APP_BASE_URL?.trim();
  if (!raw) return null;
  try {
    // Parse rather than string-trim, so a value carrying a path, query, or
    // credentials can't smuggle them into every URL built from it.
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/** Why the app must refuse to start, or null when the configuration is sound.

    The var is a security control precisely because the proxy in front is
    untrusted, so the requirement is scoped to exactly that case:

    - **Development** — the header fallback resolves to localhost. Nothing to
      configure; `npm run dev` must keep working out of the box.
    - **Vercel** — the edge overwrites `X-Forwarded-*` before the app sees it,
      so the header IS trustworthy there. Demanding the var would buy nothing
      and would break preview deploys, whose hostnames are generated per
      deployment and cannot be known in advance.
    - **Anything else in production** — Docker, Fly, Railway, Coolify, plain
      nginx. Nothing normalizes the header by default, so an unset
      `APP_BASE_URL` means the instance advertises whatever origin a caller
      asks it to. That is the hole; fail loudly instead of serving with it.

    docs/docker.md already lists the var as required for a container deploy. */
export function baseUrlStartupError(): string | null {
  if (configuredOrigin()) return null;
  if (process.env.NODE_ENV !== "production") return null;
  if (process.env.VERCEL) return null;
  return [
    "Missing required env var: APP_BASE_URL",
    "",
    "  Set it to the public URL this instance is served at, e.g.",
    "    APP_BASE_URL=https://malloyyo.example.com",
    "",
    "  Without it, the OAuth discovery documents, the /mcp WWW-Authenticate",
    "  header, sign-in redirects, and /ltool share links are all built from the",
    "  request's Host / X-Forwarded-Host header — which the caller controls",
    "  behind a proxy that does not overwrite it. A spoofed value points MCP",
    "  clients at an attacker's authorization server.",
    "",
    "  See docs/docker.md and docs/authentication.md.",
  ].join("\n");
}

export function originFromRequest(request: Request): string {
  const configured = configuredOrigin();
  if (configured) return configured;
  const host =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host");
  const proto =
    request.headers.get("x-forwarded-proto")?.split(",")[0].trim();
  if (host) {
    const scheme = proto ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
    return `${scheme}://${host}`;
  }
  return new URL(request.url).origin;
}
