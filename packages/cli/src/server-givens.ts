// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * The givens a Malloyyo server fills in, stood in for locally by environment
 * variables.
 *
 *   MALLOYYO_EMAIL=you@example.com malloyyo dashboard dev
 *
 * A model that writes `where: owner_email = $MALLOYYO_EMAIL` has, on a laptop,
 * nobody asking. Without a value the dashboard renders empty and an author
 * cannot tell a working page from a broken one — so instead of defaulting, this
 * reports what is missing and the caller refuses to run, naming the variable.
 *
 * NO CONFIG. The declared givens ARE the configuration: whatever `MALLOYYO_*`
 * names the model declares are the variables you must set. (An earlier version
 * of this put the values in `malloy-config.json` under `test_givens`. That
 * worked, but it committed a value to the repo, which needed a rule — "the
 * server must never read this block" — enforced by nothing but a comment, and
 * it invited committing a real address.)
 *
 * LOCAL ONLY, and that distinction is load-bearing rather than tidy. On a
 * laptop the process environment is one person, so it is a fair stand-in for
 * identity. On a server it is ONE VALUE FOR EVERY REQUEST, so reading identity
 * from it there would hand every user the same tenant. Nothing in the hosted
 * server reads these variables; the hosted value comes from the session
 * (src/lib/tenancy.ts). Keep it that way.
 */

import type { GivenValue } from "@malloydata/malloy";

const RESERVED_PREFIX = "MALLOYYO_";

export interface ServerGivens {
  /** Values found in the environment, for the names the model declares. */
  givens: Record<string, GivenValue>;
  /** Declared names with no variable set. Non-empty means: refuse to run. */
  missing: string[];
}

/** Which of a model's declared givens this server would fill. */
export function serverFilledNames(declared: Iterable<string>): string[] {
  return [...declared].filter((n) => n.startsWith(RESERVED_PREFIX)).sort();
}

/**
 * Read the stand-ins for `declared` out of `env`.
 *
 * An empty string counts as missing: `MALLOYYO_EMAIL=` is far more likely to be
 * an unset variable expanding to nothing than a deliberate empty identity, and
 * an empty value is exactly the one that filters nothing.
 */
export function readServerGivens(
  declared: Iterable<string>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ServerGivens {
  const out: ServerGivens = { givens: {}, missing: [] };
  for (const name of serverFilledNames(declared)) {
    const value = env[name]?.trim();
    if (value) out.givens[name] = value;
    else out.missing.push(name);
  }
  return out;
}

/** What to tell an author who has not set one. */
export function missingServerGivensMessage(missing: string[]): string {
  const example = missing
    .map((n) => `${n}=${n.endsWith("_EMAIL") ? "you@example.com" : "…"}`)
    .join(" ");
  return (
    `${missing.join(", ")}: filled by a Malloyyo server from whoever is signed in, ` +
    `and unset here. This model is scoped by ${missing.length > 1 ? "them" : "it"}, so ` +
    `running without ${missing.length > 1 ? "them" : "it"} would show nothing at all. Set ` +
    `${missing.length > 1 ? "them" : "it"} to whoever you want to look at the data as:\n` +
    `  ${example} malloyyo dashboard dev`
  );
}
