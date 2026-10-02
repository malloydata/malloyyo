// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * NAMING, now that a dataset lives in a repo.
 *
 * A dataset's public name is `<repo>:<name>` — `acme:sales`. Dataset names were
 * globally unique before, and a repo brings N common nouns into one namespace:
 * `sales`, `orders` and `users` are what model directories are actually called,
 * so two repos could not coexist. Scoping the name is the fix; the hard part is
 * that the OLD names are already in the world.
 *
 * So resolution is explicitly ordered, and the order is the whole migration
 * story:
 *
 *   1. a uuid                      — unchanged, and what every internal link uses
 *   2. `repo:dataset`              — the new, unambiguous spelling
 *   3. an ALIAS                    — every pre-existing name, pinned at migration
 *                                    time to the dataset it meant. This is what
 *                                    keeps share links, saved MCP client configs
 *                                    and committed `malloy-config.json` targets
 *                                    working, and it keeps working even after
 *                                    some other repo publishes its own `sales`
 *   4. a repo-less dataset's name  — a Claude-authored dataset has no prefix
 *   5. a bare name unique across repos — convenience for a NEW repo nobody has
 *                                    aliased, so `--dataset sales` keeps reading
 *                                    naturally while it is unambiguous
 *   6. AMBIGUOUS                   — refused, naming the qualified candidates.
 *                                    Never guessed: picking one by row order is
 *                                    how the previous design chose a credential.
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { nameToSlug } from "@malloyyo/mcp-engine";
import { db, datasetAliases, datasets, repos, type Dataset, type Repo } from "@/db";
import { qualifiedName, repoSlugFromGitHub, splitQualified } from "./repo-names";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The SPELLING rules live in ./repo-names, which imports no database - so a
// unit test and a client component can reach them. Re-exported here because
// every server-side caller wants both halves from one place.
export { QUALIFIER, qualifiedName, splitQualified, repoSlugFromGitHub } from "./repo-names";

export type DatasetRef =
  | { ok: true; dataset: Dataset; repo: Repo | null; matchedBy: "id" | "qualified" | "alias" | "name" }
  | { ok: false; error: string; ambiguous?: string[] };

async function repoOf(d: Dataset): Promise<Repo | null> {
  if (!d.repoId) return null;
  const [r] = await db.select().from(repos).where(eq(repos.id, d.repoId)).limit(1);
  return r ?? null;
}

/**
 * Resolve a dataset reference. See the order at the top of this file.
 *
 * Only LIVE datasets are reachable by name — a half-built namesake is excluded
 * by the predicate, not ordered against, which is what makes "at most one row
 * matches" true rather than likely.
 */
export async function resolveDatasetRef(ref: string): Promise<DatasetRef> {
  const trimmed = ref.trim();
  if (!trimmed) return { ok: false, error: "no dataset was named" };

  if (UUID_RE.test(trimmed)) {
    const [ds] = await db.select().from(datasets).where(eq(datasets.id, trimmed)).limit(1);
    if (!ds) return { ok: false, error: `no dataset with id ${trimmed}` };
    return { ok: true, dataset: ds, repo: await repoOf(ds), matchedBy: "id" };
  }

  const split = splitQualified(trimmed);
  if (split) {
    const [row] = await db
      .select({ ds: datasets, repo: repos })
      .from(datasets)
      .innerJoin(repos, eq(datasets.repoId, repos.id))
      .where(and(eq(repos.slug, split.repo), eq(datasets.name, split.name), eq(datasets.status, "ready")))
      .limit(1);
    if (!row) return { ok: false, error: `no dataset "${split.name}" in repo "${split.repo}"` };
    return { ok: true, dataset: row.ds, repo: row.repo, matchedBy: "qualified" };
  }

  // An alias is a primary key, so this is one row or none — no ordering, and no
  // way for a later repo to take a name out from under an old link.
  const [alias] = await db
    .select({ ds: datasets })
    .from(datasetAliases)
    .innerJoin(datasets, eq(datasetAliases.datasetId, datasets.id))
    .where(and(eq(datasetAliases.alias, trimmed), eq(datasets.status, "ready")))
    .limit(1);
  if (alias) {
    return { ok: true, dataset: alias.ds, repo: await repoOf(alias.ds), matchedBy: "alias" };
  }

  // A dataset no repo publishes: its bare name IS its identity, and
  // `datasets_unscoped_name_ready_unique` is why there is at most one.
  const [unscoped] = await db
    .select()
    .from(datasets)
    .where(and(eq(datasets.name, trimmed), isNull(datasets.repoId), eq(datasets.status, "ready")))
    .limit(1);
  if (unscoped) return { ok: true, dataset: unscoped, repo: null, matchedBy: "name" };

  const across = await db
    .select({ ds: datasets, repo: repos })
    .from(datasets)
    .innerJoin(repos, eq(datasets.repoId, repos.id))
    .where(and(eq(datasets.name, trimmed), eq(datasets.status, "ready")))
    .orderBy(repos.slug);
  if (across.length === 1) {
    return { ok: true, dataset: across[0].ds, repo: across[0].repo, matchedBy: "name" };
  }
  if (across.length > 1) {
    const candidates = across.map((r) => qualifiedName(r.repo.slug, r.ds.name));
    return {
      ok: false,
      ambiguous: candidates,
      error:
        `"${trimmed}" names a dataset in ${across.length} repos — say which: ` +
        candidates.join(", "),
    };
  }
  return { ok: false, error: `no dataset named "${trimmed}"` };
}

/** The datasets a repo publishes RIGHT NOW. Membership is the foreign key and
    the status, never a text match and never an unfiltered one. */
export async function repoDatasets(repoId: string): Promise<Dataset[]> {
  return db
    .select()
    .from(datasets)
    .where(and(eq(datasets.repoId, repoId), eq(datasets.status, "ready")))
    .orderBy(datasets.repoDir, datasets.name);
}

/** The repo's live revision, or null for one that has never published. */
export async function activeRevisionId(repoId: string): Promise<string | null> {
  const rows = await db.execute<{ id: string }>(
    sql`select id from repo_revisions where repo_id = ${repoId} and active limit 1`,
  );
  return rows[0]?.id ?? null;
}

export type RepoLookup = { repo: Repo } | { missing: true } | { error: string };

/**
 * Find the repo a publish is aimed at, from what the CLI sends.
 *
 * The CLI sends `repo: "owner/name"`, which used to mean both "this set of
 * datasets" and "GitHub backs this". Here it means the first, and GitHub is
 * consulted only as a way to IDENTIFY an already-attached repo:
 *
 *   1. a repo attached to that GitHub slug  — the same repo, reached by its
 *      GitHub identity, so a CLI push and a webhook land on one thing
 *   2. a repo whose own slug matches the leaf — the ordinary case, and the only
 *      one a never-GitHub'd repo can be found by
 *
 * `repoSlug`, when the caller sends it, overrides both. Nothing sends it today;
 * it is the way out of a slug collision without renaming a GitHub repo.
 */
export async function findRepoForPublish(opts: {
  githubRepo?: string | null;
  repoSlug?: string | null;
}): Promise<RepoLookup> {
  if (opts.repoSlug) {
    const slug = nameToSlug(opts.repoSlug);
    const [r] = await db.select().from(repos).where(eq(repos.slug, slug)).limit(1);
    return r ? { repo: r } : { missing: true };
  }
  const gh = opts.githubRepo?.trim();
  if (!gh) return { error: "a repo must be named (--repo owner/name)" };

  const attached = await db.select().from(repos).where(eq(repos.githubRepo, gh));
  if (attached.length === 1) return { repo: attached[0] };
  if (attached.length > 1) {
    // `repos_github_unique` is on (github_repo, github_branch), so the same
    // GitHub repo on two branches is two repos. The CLI has no branch to
    // disambiguate with, so say so rather than pick.
    return {
      error:
        `${gh} is attached to ${attached.length} repos on this instance, one per branch ` +
        `(${attached.map((r) => `${r.slug}@${r.githubBranch}`).join(", ")}). ` +
        `Publish to one by name.`,
    };
  }

  const slug = repoSlugFromGitHub(gh);
  const [bySlug] = await db.select().from(repos).where(eq(repos.slug, slug)).limit(1);
  if (bySlug) {
    // A repo of that name exists but is attached to a DIFFERENT GitHub repo.
    // Publishing into it would be one project overwriting another's datasets
    // because their directory names happened to match.
    if (bySlug.githubRepo && bySlug.githubRepo !== gh) {
      return {
        error:
          `this instance already has a repo named "${slug}", attached to ${bySlug.githubRepo}. ` +
          `Two repos cannot share a name — their datasets would share a namespace. ` +
          `Name this one explicitly with "repoSlug".`,
      };
    }
    return { repo: bySlug };
  }
  return { missing: true };
}

/** Load a repo by its slug. */
export async function repoBySlug(slug: string): Promise<Repo | null> {
  const [r] = await db.select().from(repos).where(eq(repos.slug, slug)).limit(1);
  return r ?? null;
}

/** Load a repo by id. */
export async function repoById(id: string): Promise<Repo | null> {
  const [r] = await db.select().from(repos).where(eq(repos.id, id)).limit(1);
  return r ?? null;
}

/** Repos for a set of datasets, keyed by repo id — for list endpoints that
    would otherwise do a query per row. */
export async function reposByIds(ids: Array<string | null>): Promise<Map<string, Repo>> {
  const wanted = [...new Set(ids.filter((i): i is string => !!i))];
  if (wanted.length === 0) return new Map();
  const rows = await db.select().from(repos).where(inArray(repos.id, wanted));
  return new Map(rows.map((r) => [r.id, r]));
}
