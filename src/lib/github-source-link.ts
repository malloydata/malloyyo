// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Build a "view this on GitHub" link for a dashboard's source file.
//
// Two ways a model gets to a server, and they carry provenance differently:
//   • CLI push   → malloy_models.git_{repo,branch,sha,dirty}, the tree that was
//                  published. The sha is exact, so prefer it.
//   • GitHub pull→ datasets.github_{repo,branch}; no sha, so the branch head is
//                  the best available and may have moved past what's live.
// Either can be absent (a model published from a non-git directory), in which
// case there is no link to show and these return null.

/** Repo as stored: "owner/repo", a browser URL, or an ssh remote. */
export function parseRepoSlug(repo: string | null | undefined): string | null {
  if (!repo) return null;
  const t = repo.trim();
  if (!t) return null;
  // git@github.com:owner/repo(.git)
  const ssh = t.match(/^git@github\.com:(.+?)(?:\.git)?$/i);
  if (ssh) return clean(ssh[1]);
  // https://github.com/owner/repo(.git)(/anything)
  const url = t.match(/^https?:\/\/(?:www\.)?github\.com\/(.+?)(?:\.git)?(?:[?#].*)?$/i);
  if (url) return clean(url[1]);
  // Bare owner/repo — reject anything that isn't exactly two path segments, so
  // a non-GitHub URL or a stray path doesn't produce a bogus github.com link.
  return clean(t);
}

function clean(slug: string): string | null {
  const parts = slug.replace(/\.git$/i, "").split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  if (parts.some((p) => /[\s?#]/.test(p))) return null;
  return `${parts[0]}/${parts[1]}`;
}

export type SourceLinkInput = {
  /** Dashboard slug — the basename of its .malloy file. */
  name: string;
  /** datasets.github_repo / github_branch (the pull path). */
  datasetRepo?: string | null;
  datasetBranch?: string | null;
  /** malloy_models.git_* (the CLI-push path). */
  gitRepo?: string | null;
  gitBranch?: string | null;
  gitSha?: string | null;
  gitDirty?: boolean | null;
  /** Model file paths, used to locate the dashboard file rather than guess it. */
  files?: { path: string }[] | null;
};

/** The path of the dashboard's .malloy within the repo, or null if not found. */
export function dashboardSourcePath(name: string, files?: { path: string }[] | null): string | null {
  const wanted = `${name}.malloy`.toLowerCase();
  const hit = files?.find((f) => f.path.toLowerCase().split("/").pop() === wanted);
  if (hit) return hit.path;
  // No file list (or a v1 model whose dashboard lives in index.malloy): the v2
  // convention is the only sensible guess, and a wrong guess costs a 404 — so
  // only guess when we had no list to search at all.
  return files && files.length > 0 ? null : `dashboards/${name}.malloy`;
}

/**
 * A github.com blob URL for the dashboard's source, or null when the dataset
 * carries no usable git provenance.
 *
 * Ref preference: the published sha (exact) → the published branch → the
 * dataset's configured branch → "main". A DIRTY publish means the live files
 * differ from that commit, so fall back to the branch rather than link a sha
 * whose contents aren't what's running.
 */
export function dashboardSourceUrl(input: SourceLinkInput): string | null {
  const slug = parseRepoSlug(input.gitRepo) ?? parseRepoSlug(input.datasetRepo);
  if (!slug) return null;
  const path = dashboardSourcePath(input.name, input.files);
  if (!path) return null;

  const ref =
    (!input.gitDirty && input.gitSha) ||
    input.gitBranch ||
    input.datasetBranch ||
    "main";

  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${slug}/blob/${encodeURIComponent(ref)}/${encodedPath}`;
}

/** The repo's own page — for a "view the model repo" affordance. */
export function repoUrl(input: Pick<SourceLinkInput, "datasetRepo" | "gitRepo">): string | null {
  const slug = parseRepoSlug(input.gitRepo) ?? parseRepoSlug(input.datasetRepo);
  return slug ? `https://github.com/${slug}` : null;
}
