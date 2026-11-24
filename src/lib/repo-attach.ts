// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * MOVE A REPO-LESS DATASET INTO A REPO — an admin's one-time act.
 *
 * Datasets published before the repo model (or by the old `publish --dataset`)
 * belong to no repo. Every publish is a repo now, so each of them is moved in
 * once, here, and from then on the ordinary publish refreshes it.
 *
 * The dataset ROW is kept — only its `repo_id` and `repo_dir` are set — so its
 * id, and everything keyed by it, survives: saved queries, favorites, drafts,
 * history, roles, scoping. Deleting and republishing would cascade those away.
 *
 * Deliberately not done by the publish itself (an earlier version "adopted" a
 * repo-less dataset whose name matched the target). Matching by name inside
 * every publish was the most complicated part of the publish path and the
 * source of most of its edge cases; an explicit move, once, has none of them.
 *
 * Until the repo's first publish the dataset keeps serving the model it has.
 */

import { and, eq, isNull } from "drizzle-orm";
import { nameToSlug } from "@malloyyo/mcp-engine";
import { db, datasetAliases, datasets, repoRevisions, repos, type Repo } from "@/db";
import { findRepoForPublish, repoSlugFromGitHub, resolveDatasetRef } from "./repos";

export type AttachResult =
  | { ok: true; repo: Repo; dir: string; createdRepo: boolean }
  | { ok: false; status: number; error: string };

/**
 * `repo` is what `malloyyo publish --repo` takes (`owner/name`); a repo that does
 * not exist yet is created, exactly as a first publish would create it. `dir` is
 * "" for the repo root (a single-dataset repo) or `datasets/<name>`.
 */
export async function attachDatasetToRepo(opts: {
  dataset: string;
  repo: string;
  dir: string;
  userId: string;
}): Promise<AttachResult> {
  const ref = await resolveDatasetRef(opts.dataset);
  if (!ref.ok) return { ok: false, status: 404, error: ref.error };
  const ds = ref.dataset;
  if (ds.repoId) return { ok: false, status: 409, error: `"${ds.name}" is already in the repo "${ref.repo?.slug}"` };

  const dir = opts.dir.trim().replace(/^\/+|\/+$/g, "");
  const leaf = dir.startsWith("datasets/") ? dir.slice("datasets/".length) : null;
  if (dir !== "" && !(leaf && nameToSlug(leaf) === leaf)) {
    return {
      ok: false,
      status: 400,
      error: `the directory is the repo root ("") or datasets/<name>, with <name> in lowercase letters, digits and underscores`,
    };
  }

  const repoName = opts.repo.trim();
  if (!repoName) return { ok: false, status: 400, error: "name the repo (owner/name)" };
  const found = await findRepoForPublish({ githubRepo: repoName });
  if ("error" in found) return { ok: false, status: 409, error: found.error };

  try {
    return await db.transaction(async (tx) => {
      let repo: Repo;
      let createdRepo = false;
      if ("repo" in found) {
        repo = found.repo;
        // THE DIRECTORY HAS TO BE ONE THE REPO PUBLISHES. A publish matches
        // datasets to the directories the repo actually has, so a dataset
        // recorded anywhere else is never refreshed — silently, with every
        // publish reporting success — and once it is in a repo it cannot be moved
        // again. The live revision says what the repo publishes; a repo with none
        // yet has nothing to check against, and the UI says the checkout must match.
        const [live] = await tx
          .select({ datasets: repoRevisions.datasets })
          .from(repoRevisions)
          .where(and(eq(repoRevisions.repoId, repo.id), eq(repoRevisions.active, true)))
          .limit(1);
        const dirs = live?.datasets?.map((d) => d.dir);
        if (dirs && !dirs.includes(dir)) {
          const what = dirs.length === 0
            ? "no datasets"
            : dirs.map((d) => (d === "" ? "one dataset from its root (index.malloy)" : d)).join(", ");
          throw new Refused(
            400,
            `the repo "${repo.slug}" publishes ${what}, not ${dir || "a root dataset"}. ` +
              `Pick one of those, or publish the repo with ${dir || "index.malloy at its root"} first.`,
          );
        }
      } else {
        const slug = repoSlugFromGitHub(repoName);
        if (!slug) throw new Refused(400, `could not make a repo name out of "${repoName}"`);
        // As a CLI publish creates one: NOT attached to GitHub. Attaching is its own act.
        [repo] = await tx
          .insert(repos)
          .values({ slug, ownerId: opts.userId, githubRepo: null, githubBranch: null, githubUseToken: false })
          .returning();
        createdRepo = true;
      }

      // One dataset per directory here, though the schema allows two (the same
      // model served twice, scoped differently): a single-dataset repo's publish
      // has to know which dataset its root IS.
      const [taken] = await tx
        .select({ name: datasets.name, dir: datasets.repoDir })
        .from(datasets)
        .where(and(eq(datasets.repoId, repo.id), eq(datasets.status, "ready")))
        .then((rows) => rows.filter((r) => r.dir === dir || r.name === ds.name));
      if (taken) {
        throw new Refused(
          409,
          taken.dir === dir
            ? `the repo "${repo.slug}" already has dataset "${taken.name}" at ${dir || "its root"}`
            : `the repo "${repo.slug}" already has a dataset named "${ds.name}"`,
        );
      }

      const [moved] = await tx
        .update(datasets)
        .set({ repoId: repo.id, repoDir: dir })
        .where(and(eq(datasets.id, ds.id), isNull(datasets.repoId)))
        .returning({ id: datasets.id });
      if (!moved) throw new Refused(409, `"${ds.name}" was moved into a repo meanwhile`);

      // Its bare name was its whole identity until now, and links use it. Once it
      // is in a repo, a second repo with a dataset of that name would make the bare
      // name ambiguous; the alias keeps it pointing here.
      await tx.insert(datasetAliases).values({ alias: ds.name, datasetId: ds.id }).onConflictDoNothing();

      return { ok: true as const, repo, dir, createdRepo };
    });
  } catch (err) {
    // A refusal THROWS, so the transaction rolls back: a repo created for this
    // move does not survive a move that was then refused.
    if (err instanceof Refused) return { ok: false, status: err.status, error: err.message };
    // A unique index lost a race: two moves (or a move and a publish) creating
    // the same new repo, or claiming the same name in it, at once.
    const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
    if (e?.code === "23505" || e?.cause?.code === "23505") {
      return { ok: false, status: 409, error: `someone else changed "${repoName}" at the same moment — try the move again` };
    }
    throw err;
  }
}

class Refused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
