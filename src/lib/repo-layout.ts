// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * What shape is this model repo — one dataset, or several?
 *
 * Two layouts, and a repo is exactly one of them:
 *
 *   index.malloy            SINGLE. The shape every repo had before this, and
 *   dashboards/             still the right one for most.
 *   malloy-config.json
 *
 *   datasets/               MULTI. Each subdirectory is a dataset, named after
 *     finance/              the directory.
 *       index.malloy
 *       dashboards/
 *     sales/
 *       index.malloy
 *   lib/                    shared, imported by relative path
 *   malloy-config.json      connections, shared by all of them
 *
 * `malloy-config.json` stays at the ROOT in both. Connections belong to the
 * repo, not to a dataset — which is also what lets `lib/` be imported from
 * `datasets/finance/index.malloy` as `../../lib/orders.malloy` and resolve, since
 * the reader keys files from the repo root.
 *
 * A repo with BOTH is an error rather than a guess. Guessing picks one and
 * publishes half of what the author meant, which looks like success.
 */

import { dirFromTree, listGitHubDir, listGitHubTree } from "./github";
import {
  DATASETS_DIR,
  ENTRY_FILE,
  layoutFromListing,
  repoPath,
  type DirLister,
  type RepoLayout,
} from "@malloyyo/mcp-engine";

// The RULES live in the engine, because `malloyyo lint` has to reach the same
// verdict about a repo on disk that this reaches about one on GitHub. Two
// copies would drift, and the drift would show up as lint blessing a repo the
// server then refuses. What lives HERE is only the GitHub binding and the
// re-rooting, neither of which the CLI has any use for.
export { DATASETS_DIR, ENTRY_FILE, layoutFromListing, repoPath };
export type { DirLister, RepoLayout };

/**
 * Read the repo's shape over the GitHub API.
 *
 * Every failure names the file or directory to fix. A model repo is edited by
 * someone who cannot see this server's logs, so "which layout did you mean" has
 * to be answerable from the message alone.
 */
export async function discoverRepoLayout(
  owner: string,
  repo: string,
  branch: string,
  opts: { useToken?: boolean } = {},
): Promise<RepoLayout> {
  // One request for the whole tree when GitHub will give it, falling back to a
  // request per directory when it will not (rate limit, or a repo too large to
  // return whole). The rules are the same either way.
  const tree = await listGitHubTree(owner, repo, branch, opts);
  const list: DirLister = tree
    ? async (path) => dirFromTree(tree, path)
    : (path) => listGitHubDir(owner, repo, branch, path, opts);
  return layoutFromListing(list, `${owner}/${repo}@${branch}`);
}



/**
 * Re-root a dataset's fetched files so its own directory becomes the model root.
 *
 * `datasets/finance/index.malloy` is stored as `index.malloy`, its
 * `dashboards/x.malloy` as `dashboards/x.malloy`, and a shared
 * `lib/orders.malloy` keeps its repo-root path. That is exactly what
 * `import "../../lib/orders.malloy"` resolves to from the re-rooted entry, because
 * URL resolution clamps `..` at the root — so the file map a multi-dataset
 * repo produces is indistinguishable from a single-dataset one's.
 *
 * Which is the point. Every consumer of a stored model — the MCP query entry,
 * dashboards, drafts, the restricted-query gate — assumes a model is rooted at
 * `index.malloy`, and threading a per-dataset entry path through all of them
 * would put a new variable in the middle of the query path. The only thing that
 * still needs the real repo path is a github.com link, and that gets it from
 * `datasets.repo_dir`.
 *
 * Returns an error instead of a map when two files would land on one path.
 */
export function rerootFiles(
  files: ReadonlyMap<string, string>,
  dir: string | null | undefined,
): { ok: true; files: Map<string, string> } | { ok: false; error: string } {
  const base = (dir ?? "").replace(/^\/+|\/+$/g, "");
  if (!base) return { ok: true, files: new Map(files) };

  const prefix = `${base}/`;
  const out = new Map<string, string>();
  const collisions: string[] = [];
  for (const [path, content] of files) {
    const next = path.startsWith(prefix) ? path.slice(prefix.length) : path;
    if (out.has(next)) collisions.push(next);
    out.set(next, content);
  }
  if (collisions.length > 0) {
    return {
      ok: false,
      error:
        `${collisions.join(", ")}: this dataset's directory and the repo root both contain ` +
        `${collisions.length > 1 ? "these paths" : "this path"}, so one would hide the other. ` +
        `Rename one of them.`,
    };
  }
  return { ok: true, files: out };
}
