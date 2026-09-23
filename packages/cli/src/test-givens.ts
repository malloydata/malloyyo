// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * `test_givens` — stand-in values for the givens the SERVER fills, so a
 * tenant-scoped model can be run before it is published.
 *
 *   {
 *     "malloyyo": {
 *       "test_givens": { "MALLOYYO_EMAIL": "you@example.com" }
 *     }
 *   }
 *
 * A model that writes `where: owner_email = $MALLOYYO_EMAIL` has, locally, no
 * one asking: the declaration default applies, the rows come back empty, and
 * the author cannot tell a working dashboard from a broken one. This block is
 * the answer — `malloyyo dashboard dev`, `bundle` and the CLI's own MCP server
 * bind it exactly as the server would bind the signed-in user's address, so
 * what an author sees locally is what a reader gets.
 *
 * THIS FILE IS LOCAL-ONLY, and that is a security property rather than a
 * layering preference. The value is author-supplied and travels with the repo,
 * so a hosted instance that honored it would let any repo name any address and
 * read that person's rows. Nothing under src/ on the server may read this block
 * — the server's value comes from the session (src/lib/tenancy.ts), and the
 * publish path strips it rather than storing it.
 *
 * Only the reserved `MALLOYYO_*` names are honored, because they are the only
 * ones the server fills; an ordinary given's local value belongs in its
 * declaration default or the dashboard's own `# artifact { givens { … } }`.
 */

import type { GivenValue } from "@malloydata/malloy";

const RESERVED_PREFIX = "MALLOYYO_";

export interface TestGivensResult {
  givens: Record<string, GivenValue>;
  /** Keys that were ignored, with why — surfaced by `malloyyo lint`. */
  warnings: string[];
}

/**
 * Read the block out of a malloy-config.json string.
 *
 * Never throws: a malformed config means the model won't load either, and this
 * is a development convenience, not a gate. Anything unusable is reported as a
 * warning and dropped.
 */
export function testGivensFromConfig(configJson: string | undefined | null): TestGivensResult {
  const out: TestGivensResult = { givens: {}, warnings: [] };
  if (!configJson) return out;
  let raw: unknown;
  try {
    raw = JSON.parse(configJson);
  } catch {
    return out;
  }
  const block = (raw as { malloyyo?: { test_givens?: unknown } })?.malloyyo?.test_givens;
  if (block === undefined) return out;
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    out.warnings.push('malloy-config.json: "test_givens" must be an object of name → value.');
    return out;
  }
  for (const [name, value] of Object.entries(block as Record<string, unknown>)) {
    if (!name.startsWith(RESERVED_PREFIX)) {
      out.warnings.push(
        `test_givens: ignoring "${name}" — only ${RESERVED_PREFIX}* givens are filled by the ` +
          `server, so only those need a local stand-in. Give an ordinary given a default in ` +
          `its declaration, or set it per dashboard with \`# artifact { givens { … } }\`.`,
      );
      continue;
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      out.warnings.push(`test_givens: ignoring "${name}" — value must be a string, number or boolean.`);
      continue;
    }
    out.givens[name] = value as GivenValue;
  }
  return out;
}
