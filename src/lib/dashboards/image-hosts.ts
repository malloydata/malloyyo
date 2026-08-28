// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The dashboard frame's `img-src` allowlist, declared per repo in
// malloy-config.json:
//
//   { "malloyyo": { "image_hosts": ["image.tmdb.org", "*.cdn.example.com"] } }
//
// WHY THIS EXISTS: the frame CSP is default-deny (`img-src data: blob:`), so a
// dashboard that builds <img src> from a model column — poster art, logos,
// avatars — silently loses every image once published, while still working from
// a bundle and from the CLI dev server (neither sends a CSP). There was no hook
// to widen it: the directive was a literal. The alternatives are all worse —
// inlining as `data:` pushes megabytes of base64 through the result set, and
// fetching to a `blob:` is blocked by `connect-src 'none'`.
//
// WHY IT IS AN ALLOWLIST AND NOT `img-src https:`: with `connect-src 'none'`, an
// image URL is the remaining channel through which sandboxed dashboard code can
// smuggle row data out (encode it in the path, read the hit off the host's
// logs). Naming hosts means the model owner — who already owns the data and
// wrote the JSX — chose the recipient. A blanket `https:` would reopen that for
// every dashboard on the server, including ones whose authors never asked.
//
// THIS FILE IS A TRUST BOUNDARY. The values arrive from a .malloy repo via
// GitHub or `publish`, sit in Postgres as untrusted JSON, and end up in a
// RESPONSE HEADER. A string that reached the header unfiltered could close the
// directive and append its own:
//
//   "image_hosts": ["x; script-src 'unsafe-inline'"]
//
// ...which would defeat the nonce-only script-src the whole frame design rests
// on. So nothing is ever passed through: each entry must match a strict
// hostname shape and is re-emitted from scratch as `https://<host>`. Validate
// HERE rather than only at the call site — the DB is the source, and no
// author-time lint sits in front of it.

/** Hosts per repo. Generous for real use, small enough that a runaway or
    hostile config can't bloat the header. Extra entries are dropped. */
const MAX_HOSTS = 8;

/** A bare DNS hostname: labels of [a-z0-9-] that neither start nor end with a
    hyphen, at least two of them (so `localhost` and, more to the point, bare
    keywords like `https` or `data` can't slip through as a "host"). Anchored,
    so a `;`, quote, space, slash, port, path, or control character anywhere in
    the string fails the match — that is the injection defense, expressed as
    what's allowed rather than as a blocklist. */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * Untrusted input → CSP host-source tokens, or nothing.
 *
 * Accepts `host`, `https://host`, and `*.host` (the wildcard is a deliberate
 * branch — the `*.` is stripped, the remainder validated as a hostname, and the
 * token rebuilt — never a string carried through because it happened to contain
 * a star). Anything else is dropped silently: a malformed entry should cost the
 * author their images, not the whole dashboard render.
 */
export function normalizeImageHosts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    let host = entry.trim();
    if (host === "") continue;
    // Tolerate the scheme an author is likely to paste, but only this exact
    // prefix — and only https, since the emitted token is https either way.
    if (/^https:\/\//i.test(host)) host = host.slice("https://".length);
    // Strip a trailing slash from a pasted origin ("https://x.dev/").
    if (host.endsWith("/")) host = host.slice(0, -1);

    let wildcard = false;
    if (host.startsWith("*.")) {
      wildcard = true;
      host = host.slice(2);
    }
    if (!HOSTNAME.test(host)) continue;

    const token = `https://${wildcard ? "*." : ""}${host.toLowerCase()}`;
    if (!out.includes(token)) out.push(token);
    if (out.length === MAX_HOSTS) break;
  }
  return out;
}

/**
 * The declared hosts from a malloy-config.json string.
 *
 * Same shape as poolSizeFromConfig in @/lib/malloy: the config travels with the
 * model as an ordinary model file (the CLI publish route stores it under
 * "malloy-config.json", as does the GitHub refresh), so reading a setting is a
 * parse, and a malformed config is not an error here — it just declares nothing.
 */
export function imageHostsFromConfig(configJson: string | undefined | null): string[] {
  if (!configJson) return [];
  try {
    const parsed = JSON.parse(configJson) as { malloyyo?: { image_hosts?: unknown } };
    return normalizeImageHosts(parsed?.malloyyo?.image_hosts);
  } catch {
    // Malformed config — the model itself won't have loaded either. Declare nothing.
    return [];
  }
}
