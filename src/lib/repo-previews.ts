// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * BRANCH PREVIEWS: a repo's branch, fetched to look at, never to serve.
 *
 * Addressed as `repo@ref:dataset` — `malloyyo_test@add-products:products` — by
 * anything that names a dataset: the MCP tools, the dashboard routes, the
 * dataset pages. `ref` is a branch name, or a commit SHA (or its prefix) of a
 * fetched snapshot.
 *
 * A SNAPSHOT, NOT A WINDOW ONTO GITHUB. The branch is being developed somewhere
 * else (Claude, locally); the instance sees it only when someone fetches it —
 * `fetch_branch` after a push, Fetch on the repo page, or
 * `malloyyo publish --branch <name>` uploading a working tree before any push.
 * Every request after that is a database read: no GitHub call per request, so
 * no rate limit and no stale branch names. A fetch replaces what the address
 * shows; the older snapshots stay, reachable by their SHA.
 *
 * STORED AS A REVISION, never activated (`repo_revisions.preview`). Its archive
 * is the record of its bytes, exactly as a published revision's is, so its
 * files come out of the same `modelFilesFor` view, and it is compiled by the
 * same `compileDir` a publish uses. What it does NOT have is model or artifact
 * rows: `preview_datasets` holds the compile result instead. That keeps it out
 * of every "what does this dataset serve" query by construction — and lets a
 * preview carry a dataset that does not exist here yet, which is the point of
 * previewing a branch that adds one.
 *
 * ADMIN ONLY, to fetch and to view: it is model code nobody has reviewed,
 * running on this server with its connections' credentials.
 */

import { and, desc, eq, like } from "drizzle-orm";
import { db, datasets, repoRevisions, type Dataset, type PreviewDataset, type Repo } from "@/db";

type Fail = { ok: false; error: string };

// The address (`repo@ref:dataset`) and the preview cache keys are pure; they
// live apart so they can be tested without a database. Fetching and compiling a
// snapshot is src/lib/repo-preview-store.ts — kept out of this module because
// pages import it (through mcp-tools), and compiling pulls in DuckDB.
export * from "./repo-preview-refs";
import { previewModelId, previewRef } from "./repo-preview-refs";

// ── resolving ────────────────────────────────────────────────────────────────

export type ResolvedPreview = {
  ok: true;
  repo: Repo;
  revision: typeof repoRevisions.$inferSelect;
  entry: PreviewDataset;
  /** The canonical address: `repo@branch:dataset`. */
  address: string;
};

/** The latest fetched snapshot for `ref` (a branch, or a SHA or its prefix). */
async function previewRevision(repoId: string, ref: string) {
  const bySha = /^[0-9a-f]{7,40}$/i.test(ref);
  const [row] = await db
    .select()
    .from(repoRevisions)
    .where(
      and(
        eq(repoRevisions.repoId, repoId),
        eq(repoRevisions.preview, true),
        bySha ? like(repoRevisions.gitSha, `${ref.toLowerCase()}%`) : eq(repoRevisions.gitBranch, ref),
      ),
    )
    .orderBy(desc(repoRevisions.createdAt))
    .limit(1);
  return row ?? null;
}

export async function resolvePreview(
  ref: { repo: string; ref: string; dataset: string },
  findRepo: (slug: string) => Promise<Repo | null>,
): Promise<ResolvedPreview | Fail> {
  const repo = await findRepo(ref.repo);
  if (!repo) return { ok: false, error: `No repo "${ref.repo}" on this instance.` };
  const revision = await previewRevision(repo.id, ref.ref);
  if (!revision) {
    return {
      ok: false,
      error:
        `"${ref.ref}" of ${repo.slug} hasn't been fetched. Fetch it first (fetch_branch, Fetch on the repo ` +
        `page, or \`malloyyo publish --branch ${ref.ref}\`).`,
    };
  }
  const entry = (revision.previewDatasets ?? []).find((d) => d.name === ref.dataset);
  if (!entry) {
    const names = (revision.previewDatasets ?? []).map((d) => d.name).join(", ") || "none";
    return { ok: false, error: `The ${ref.ref} snapshot of ${repo.slug} has no dataset "${ref.dataset}" (it has: ${names}).` };
  }
  if (!entry.ok) return { ok: false, error: `${ref.dataset} didn't compile in that snapshot: ${entry.error}` };
  return { ok: true, repo, revision, entry, address: previewRef(repo.slug, revision.gitBranch ?? ref.ref, entry.name) };
}

/**
 * The dataset and model a preview stands in for, shaped like the rows the rest
 * of the app reads. The dataset is the live one when this directory already
 * publishes a dataset (its id, its scoping), and a stand-in when the branch is
 * what adds it; the model is never a row — its id is the preview cache key and
 * its revision is the snapshot, which is all `modelFileMap` needs.
 */
export async function previewRows(p: ResolvedPreview) {
  const [existing] = await db
    .select()
    .from(datasets)
    .where(and(eq(datasets.repoId, p.repo.id), eq(datasets.repoDir, p.entry.dir), eq(datasets.status, "ready")))
    .limit(1);
  const ds = {
    ...(existing ?? standInDataset(p)),
    title: p.entry.title ?? existing?.title ?? null,
    description: p.entry.description ?? existing?.description ?? null,
  } as Dataset;
  const model = {
    id: previewModelId(p.revision.id, p.entry.dir),
    datasetId: ds.id,
    revisionId: p.revision.id,
    active: false,
    version: 0,
    source: "",
    generatedBy: "preview",
    compiledAt: p.revision.createdAt,
    compileError: null,
    sources: p.entry.sources ?? [],
    gitRepo: p.repo.githubRepo,
    gitBranch: p.revision.gitBranch,
    gitSha: p.revision.gitSha,
    gitDirty: p.revision.gitDirty,
    compiledModelDef: null,
    createdAt: p.revision.createdAt,
  };
  return { ds, model, existed: Boolean(existing) };
}

/** The id a preview of a not-yet-existing dataset carries. Names no row; the
    history writer maps it to no dataset. */
export const STAND_IN_DATASET_ID = "00000000-0000-0000-0000-000000000000";

/** A dataset row for a directory that has none yet. Never written. */
function standInDataset(p: ResolvedPreview): Partial<Dataset> {
  return {
    // Not a real dataset id: nothing may record against it. Callers check
    // `existed` (via `preview.isNew`) before writing history or favorites.
    id: STAND_IN_DATASET_ID,
    userId: p.repo.ownerId,
    name: p.entry.name,
    isPublic: false,
    status: "ready",
    statusError: null,
    githubRepo: p.repo.githubRepo,
    githubBranch: p.revision.gitBranch,
    githubUseToken: p.repo.githubUseToken,
    repoId: p.repo.id,
    repoDir: p.entry.dir,
    requiredGivens: [],
  };
}

/** For messages: "a8aa295, fetched 3 minutes ago (uploaded, uncommitted changes)". */
export function describeSnapshot(rev: { gitSha: string | null; gitDirty: boolean | null; source: string; createdAt: Date }): string {
  const mins = Math.max(0, Math.round((Date.now() - rev.createdAt.getTime()) / 60000));
  const when = mins < 1 ? "just now" : mins < 120 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
  const how = rev.source === "cli" ? (rev.gitDirty ? "uploaded, with uncommitted changes" : "uploaded") : "from GitHub";
  return `${rev.gitSha ? rev.gitSha.slice(0, 7) : "no commit"}, fetched ${when} (${how})`;
}

