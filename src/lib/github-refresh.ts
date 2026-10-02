// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * PULLING A REPO FROM GITHUB.
 *
 * All that is left here is the GitHub binding: fetch the repo as a zip, read the
 * head commit, and hand both to the one publish pipeline
 * (src/lib/repo-publish.ts). A GitHub push and a `malloyyo publish` differ in
 * how the bytes arrive and in nothing else.
 *
 * WHAT A REFRESH REFRESHES IS THE REPO'S OWN QUESTION. It used to be recomputed
 * on every call by matching `(github_repo, github_branch)` against every dataset
 * row, with no status filter — which against the production fork matched seven
 * rows for one repo, none of them live. The credential came out of `rows[0]` on
 * a query with no ORDER BY. Now the repo is a row: it has an id, an owner, a
 * branch and one answer about its token.
 *
 * NOTHING HERE DESTROYS. Delete a dataset's directory and the repo simply stops
 * publishing it: that dataset is not refreshed and nothing of it is removed.
 * Saved queries, share links and history pointing at it are somebody's work, and
 * a commit is not a decision to throw that away.
 */

import { eq } from "drizzle-orm";
import { db, repos, type Repo } from "@/db";
import { fetchGitHubCommitSha, fetchGitHubZipball, parseGitHubRepo } from "./github";
import { logger } from "./logger";
import { publishRevision, type PublishResult } from "./repo-publish";

export type RepoFetch =
  | { ok: true; zip: Buffer; sha: string | null; branch: string }
  | { ok: false; error: string };

/**
 * The repo's bytes and its head commit.
 *
 * `github_use_token` comes off the REPO, which is the only place it is stored.
 * One repo, one answer — not three dataset rows with two different values and a
 * winner picked by row order, which for a private repo is an intermittent,
 * unexplainable 404 that flips between refreshes.
 */
export async function fetchRepo(repo: Repo): Promise<RepoFetch> {
  if (!repo.githubRepo) {
    return {
      ok: false,
      error:
        `${repo.slug} is not attached to GitHub. It was published with the CLI; ` +
        `attach it to a GitHub repo to refresh it from a commit.`,
    };
  }
  const branch = repo.githubBranch ?? "main";
  let owner: string;
  let name: string;
  try {
    ({ owner, repo: name } = parseGitHubRepo(repo.githubRepo));
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const zip = await fetchGitHubZipball(owner, name, branch, { useToken: repo.githubUseToken });
  if (!zip) {
    return {
      ok: false,
      error:
        `GitHub would not give ${repo.githubRepo}@${branch}. ` +
        (repo.githubUseToken
          ? `Check the repo exists on that branch and that GITHUB_TOKEN can read it.`
          : // NOT "turn on the checkbox": there is no UI for the repo's
            // credential flag, so naming one would send someone looking for a
            // control that does not exist. The honest instruction is the one
            // that works today.
            `This repo is set not to send GITHUB_TOKEN, so a private repo would 404. ` +
              `An admin can re-add it with "use GITHUB_TOKEN" to change that.`),
    };
  }
  const sha = await fetchGitHubCommitSha(owner, name, branch, { useToken: repo.githubUseToken });
  return { ok: true, zip, sha, branch };
}

/**
 * Refresh a repo from its configured branch: one new revision, verified inline,
 * activated only if every dataset in it compiled.
 *
 * Identical bytes short-circuit, so a webhook storm does not mint fifty
 * revisions of the same commit — but only against the LIVE revision. A stored
 * revision with these bytes that failed to verify is retried, because the
 * failure may have been a warehouse that was down rather than the model.
 */
export async function refreshRepo(
  repoId: string,
  opts: { createDatasets?: boolean } = {},
): Promise<PublishResult> {
  const [repo] = await db.select().from(repos).where(eq(repos.id, repoId)).limit(1);
  if (!repo) return { ok: false, kind: "request", error: `no repo with id ${repoId}` };

  const fetched = await fetchRepo(repo);
  if (!fetched.ok) {
    logger.error("repo refresh could not read the repo", {
      repo: repo.slug,
      github: repo.githubRepo,
      error: fetched.error,
    });
    return { ok: false, kind: "request", error: fetched.error };
  }

  return publishRevision({
    repo,
    raw: fetched.zip,
    source: "github",
    // A webhook has no user. A refresh clicked in the UI could pass one, but the
    // revision's author is not an authorization input anywhere, so leaving it
    // null for every pull keeps "who published this" honest.
    createdById: null,
    git: { sha: fetched.sha, branch: fetched.branch, dirty: false },
    createDatasets: opts.createDatasets ?? false,
  });
}
