// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * Taking a BRANCH PREVIEW snapshot (src/lib/repo-previews.ts has the model):
 * from GitHub (`fetch_branch`, Fetch on the repo page), or from a working tree
 * the CLI uploads (`malloyyo publish --branch`). Both compile with the publish
 * pipeline's own `compileDir`, which is why this lives apart from the
 * resolving half — a page may import that, and must never import DuckDB.
 */

import { and, eq } from "drizzle-orm";
import { layoutFromListing } from "@malloyyo/mcp-engine";
import { db, datasets, repoRevisions, type PreviewDataset, type Repo, type RepoRevisionSource } from "@/db";
import { fetchGitHubCommitSha, fetchGitHubZipball, parseGitHubRepo } from "./github";
import { discardWorkspace, materializeArchive, normalizeArchive, ArchiveError } from "./repo-archive";
import { previewRef } from "./repo-preview-refs";
import { compileDir, localConfigRefusal, storeRevision } from "./repo-publish";
import { fsLister } from "./repo-workspace";

type Fail = { ok: false; error: string };

export type PreviewSummary = {
  ok: true;
  repo: string;
  branch: string;
  commit: string | null;
  dirty: boolean;
  source: RepoRevisionSource;
  revision: number;
  fetchedAt: string;
  datasets: Array<PreviewDataset & { address: string; status: "new" | "existing" }>;
};

/** Fetch a branch from GitHub into a preview snapshot. */
export async function fetchBranchPreview(repo: Repo, branch: string, userId: string): Promise<PreviewSummary | Fail> {
  if (!repo.githubRepo) {
    return { ok: false, error: `${repo.slug} is not attached to GitHub; upload a working tree with \`malloyyo publish --branch\` instead.` };
  }
  let owner: string;
  let name: string;
  try {
    ({ owner, repo: name } = parseGitHubRepo(repo.githubRepo));
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const sha = await fetchGitHubCommitSha(owner, name, branch, { useToken: repo.githubUseToken });
  if (!sha) return { ok: false, error: `GitHub has no branch "${branch}" in ${repo.githubRepo}.` };
  // By SHA, so the bytes are exactly the commit just named — not whatever the
  // branch moved to between the two requests.
  const raw = await fetchGitHubZipball(owner, name, sha, { useToken: repo.githubUseToken });
  if (!raw) return { ok: false, error: `GitHub would not give ${repo.githubRepo} at ${sha.slice(0, 12)}.` };
  return storePreview(repo, raw, { source: "github", branch, sha, dirty: false, createdById: userId });
}

/**
 * Store and compile a preview snapshot. Shared by the GitHub fetch and the CLI's
 * `publish --branch` upload, so both compile — and fail — the same way.
 */
export async function storePreview(
  repo: Repo,
  raw: Buffer,
  meta: { source: RepoRevisionSource; branch: string; sha: string | null; dirty: boolean; createdById: string | null },
): Promise<PreviewSummary | Fail> {
  const branch = meta.branch.trim();
  if (!branch || branch.includes(":") || /\s/.test(branch)) {
    return { ok: false, error: `"${meta.branch}" is not a branch name.` };
  }
  let archive;
  try {
    archive = await normalizeArchive(raw, { stripWrapper: meta.source === "github" });
  } catch (err) {
    if (err instanceof ArchiveError) return { ok: false, error: err.message };
    throw err;
  }
  const local = localConfigRefusal(archive.entries);
  if (local) return { ok: false, error: local };

  const root = materializeArchive(archive.zip, repo.slug);
  try {
    const layout = await layoutFromListing(fsLister(root), `${repo.slug}@${branch}`);
    if (!layout.ok) return { ok: false, error: layout.error };
    const declared =
      layout.kind === "single" ? [{ name: repo.slug, dir: "" }] : layout.datasets.map((d) => ({ name: d.name, dir: d.dir }));
    const allDirs = declared.map((d) => d.dir);
    const filePaths = archive.entries.filter((e) => !e.isDir).map((e) => e.path);

    // A single-dataset repo's dataset is named by its row, not a directory.
    const live = await db
      .select()
      .from(datasets)
      .where(and(eq(datasets.repoId, repo.id), eq(datasets.status, "ready")));
    const byDir = new Map(live.map((d) => [d.repoDir, d]));
    if (layout.kind === "single" && byDir.get("")) declared[0].name = byDir.get("")!.name;

    const compiled: PreviewDataset[] = [];
    for (const d of declared) {
      const r = await compileDir(root, d.dir, d.name, allDirs, filePaths);
      compiled.push(
        r.ok
          ? {
              name: d.name,
              dir: d.dir,
              ok: true,
              title: r.compiled.title,
              description: r.compiled.description,
              sources: r.compiled.sources.map((s) => ({ name: s.name, description: s.description ?? null })),
              declaredGivens: r.compiled.declaredGivens,
              artifacts: r.compiled.artifacts.map((a) => ({
                name: a.name,
                title: a.title ?? null,
                manifest: a.manifest,
                source: a.source ?? "",
              })),
            }
          : { name: d.name, dir: d.dir, ok: false, error: r.error },
      );
    }

    const revision = await storeRevision(
      {
        repo,
        raw,
        source: meta.source,
        createdById: meta.createdById,
        git: { sha: meta.sha, branch, dirty: meta.dirty },
      },
      archive,
      { preview: true },
    );
    await db
      .update(repoRevisions)
      .set({
        datasets: declared,
        previewDatasets: compiled,
        verifiedAt: compiled.every((c) => c.ok) ? new Date() : null,
        verifyError: compiled.filter((c) => !c.ok).map((c) => `${c.name}: ${c.error}`).join("; ") || null,
      })
      .where(eq(repoRevisions.id, revision.id));

    return {
      ok: true,
      repo: repo.slug,
      branch,
      commit: meta.sha,
      dirty: meta.dirty,
      source: meta.source,
      revision: revision.revision,
      fetchedAt: revision.createdAt.toISOString(),
      datasets: compiled.map((c) => ({
        ...c,
        artifacts: c.artifacts?.map((a) => ({ ...a, source: a.source ? "(component)" : "" })),
        address: previewRef(repo.slug, branch, c.name),
        status: byDir.has(c.dir) ? "existing" : "new",
      })),
    };
  } finally {
    discardWorkspace(root);
  }
}

