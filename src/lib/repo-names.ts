// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * How a repo and its datasets are SPELLED. No database, on purpose.
 *
 * `repos.ts` holds the lookups, which need `@/db` — and `@/db` reads
 * `DATABASE_URL` at import time, so anything importing it cannot be reached from
 * a unit test or a client component. The spelling rules are the part other code
 * and tests actually want, so they live here. (Same split as
 * src/lib/api-token-scopes.ts.)
 */

import { nameToSlug } from "@malloyyo/mcp-engine";

/**
 * The separator between a repo and a dataset.
 *
 * A colon rather than a slash: a dataset ref travels in URL paths that already
 * carry slashes, and in `--dataset <name>`, and in a `malloy-config.json`
 * target. A slash would have made every one of those ambiguous.
 */
export const QUALIFIER = ":";

/** `acme:sales`, or just `sales` for a dataset no repo publishes. */
export function qualifiedName(repoSlug: string | null | undefined, name: string): string {
  return repoSlug ? `${repoSlug}${QUALIFIER}${name}` : name;
}

/**
 * Split a ref that carries a qualifier. Null when it carries none.
 *
 * Strict about the shape: `a:b:c` is not a nesting, so it is not half-parsed and
 * falls through to the alias table.
 *
 * A ref with exactly ONE colon is always read as `repo:dataset`, which means an
 * alias containing one colon is unreachable. That is deliberate — the qualified
 * form has to win or `<repo>:<name>` would be ambiguous with whatever anyone
 * aliased — but it is a real limit: the migration only ever writes aliases from
 * existing dataset NAMES, which `nameToSlug` has already stripped of colons, so
 * nothing in the wild hits it.
 */
export function splitQualified(ref: string): { repo: string; name: string } | null {
  const i = ref.indexOf(QUALIFIER);
  if (i <= 0 || i === ref.length - 1) return null;
  const repo = ref.slice(0, i);
  const name = ref.slice(i + 1);
  if (name.includes(QUALIFIER)) return null;
  return { repo, name };
}

/**
 * A repo slug from a GitHub slug.
 *
 * The LAST path segment, slugified by the same `nameToSlug` the layout rules use
 * for a dataset directory — so a repo and its datasets are named by one rule,
 * and `0026_repos_first_class.sql`'s backfill reproduces it in SQL.
 */
export function repoSlugFromGitHub(githubRepo: string): string {
  const leaf = githubRepo.trim().replace(/\.git$/i, "").split(/[/:]/).filter(Boolean).pop() ?? "";
  return nameToSlug(leaf);
}
