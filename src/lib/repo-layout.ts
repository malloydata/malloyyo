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

import { dirFromTree, listGitHubDir, listGitHubTree, type GitHubDirEntry } from "./github";
import { nameToSlug } from "./slug";

export const DATASETS_DIR = "datasets";
export const ENTRY_FILE = "index.malloy";

export type DiscoveredDataset = {
  /** The dataset name: the directory's, slugified the same way a typed name is. */
  name: string;
  /** Where its `index.malloy` and `dashboards/` live, e.g. `datasets/finance`. */
  dir: string;
};

export type RepoLayout =
  | { ok: true; kind: "single" }
  | { ok: true; kind: "multi"; datasets: DiscoveredDataset[] }
  | { ok: false; error: string };

/**
 * Read the repo's shape from its root listing (one API call, plus one per
 * candidate dataset directory).
 *
 * Every failure names the file or directory to fix. A model repo is edited by
 * someone who cannot see this server's logs, so "which layout did you mean"
 * has to be answerable from the message alone.
 */
export async function discoverRepoLayout(
  owner: string,
  repo: string,
  branch: string,
  opts: { useToken?: boolean } = {},
): Promise<RepoLayout> {
  // One request for the whole tree when GitHub will give it, falling back to a
  // request per directory when it will not (rate limit, or a repo too large to
  // return whole). The rules below are the same either way.
  const tree = await listGitHubTree(owner, repo, branch, opts);
  const list: DirLister = tree
    ? async (path) => dirFromTree(tree, path)
    : (path) => listGitHubDir(owner, repo, branch, path, opts);
  return layoutFromListing(list, `${owner}/${repo}@${branch}`);
}

/** Lists one directory of the repo, "" being the root. */
export type DirLister = (path: string) => Promise<GitHubDirEntry[]>;

/**
 * The layout rules themselves, over an injected lister.
 *
 * Split out so the rules are testable without a network: every branch below is
 * a refusal someone has to act on, and a rule nobody can exercise offline is a
 * rule that drifts.
 */
export async function layoutFromListing(list: DirLister, label = "this repo"): Promise<RepoLayout> {
  const root = await list("");
  if (root.length === 0) {
    return { ok: false, error: `${label} is empty or could not be read.` };
  }

  const hasRootEntry = root.some((e) => e.type === "file" && e.name === ENTRY_FILE);
  const hasDatasetsDir = root.some((e) => e.type === "dir" && e.name === DATASETS_DIR);

  if (hasRootEntry && hasDatasetsDir) {
    return {
      ok: false,
      error:
        `This repo has both a top-level ${ENTRY_FILE} and a ${DATASETS_DIR}/ directory, ` +
        `and those are two different layouts. Use one: keep ${ENTRY_FILE} at the root to ` +
        `publish a single dataset, or move it under ${DATASETS_DIR}/<name>/ and delete the ` +
        `root one to publish several.`,
    };
  }

  if (hasRootEntry) return { ok: true, kind: "single" };

  if (!hasDatasetsDir) {
    return {
      ok: false,
      error:
        `No ${ENTRY_FILE} at the root of ${label}, and no ${DATASETS_DIR}/ ` +
        `directory either. A model repo needs one or the other.`,
    };
  }

  const subdirs = (await list(DATASETS_DIR)).filter((e) => e.type === "dir");
  if (subdirs.length === 0) {
    return {
      ok: false,
      error: `${DATASETS_DIR}/ has no subdirectories — each dataset is a directory under it.`,
    };
  }

  // Every candidate must actually be a dataset. A subdirectory with no
  // `index.malloy` is refused by name rather than skipped: skipping publishes
  // three of the four datasets someone wrote and reports success, and the one
  // that vanished is the one nobody checks.
  const found: DiscoveredDataset[] = [];
  const missing: string[] = [];
  for (const d of subdirs) {
    const inside = await list(`${DATASETS_DIR}/${d.name}`);
    if (inside.some((e) => e.type === "file" && e.name === ENTRY_FILE)) {
      found.push({ name: nameToSlug(d.name), dir: `${DATASETS_DIR}/${d.name}` });
    } else {
      missing.push(`${DATASETS_DIR}/${d.name}`);
    }
  }
  if (missing.length > 0) {
    return {
      ok: false,
      error:
        `${missing.join(", ")}: every directory under ${DATASETS_DIR}/ is a dataset and needs its ` +
        `own ${ENTRY_FILE}. Add one, or move the directory out of ${DATASETS_DIR}/ if it is ` +
        `shared code (a sibling \`lib/\` is imported by relative path).`,
    };
  }

  // Two directories that slugify the same would race for one name, and which one
  // won would depend on insert order.
  const byName = new Map<string, string[]>();
  for (const d of found) byName.set(d.name, [...(byName.get(d.name) ?? []), d.dir]);
  const collided = [...byName.entries()].filter(([, dirs]) => dirs.length > 1);
  if (collided.length > 0) {
    return {
      ok: false,
      error: collided
        .map(([name, dirs]) => `${dirs.join(" and ")} both publish a dataset named "${name}"`)
        .join("; "),
    };
  }

  return { ok: true, kind: "multi", datasets: found.sort((a, b) => a.name.localeCompare(b.name)) };
}

/** A path inside a dataset's own directory. `dir` null/empty is the repo root,
    which is what every single-dataset repo and every pre-existing row is. */
export function repoPath(dir: string | null | undefined, rest: string): string {
  const base = (dir ?? "").replace(/^\/+|\/+$/g, "");
  return base ? `${base}/${rest}` : rest;
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
