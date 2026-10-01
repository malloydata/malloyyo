// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * What shape is a model repo — one dataset, or several?
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
 * `malloy-config.json` may sit at the ROOT, where every dataset shares it, or
 * inside a dataset, where it is that dataset's own and replaces the root's.
 * Nearest one wins — which is what `discoverConfig` does walking up from a model
 * root, and what the server mirrors when it compiles from an archive.
 *
 * A repo with BOTH is an error rather than a guess. Guessing picks one and
 * publishes half of what the author meant, which looks like success.
 *
 * IN THE ENGINE because both sides need the same answer. The server reads a repo
 * over the GitHub API; `malloyyo lint` reads the one on your disk — and if those
 * two disagreed about what a repo publishes, lint would bless a repo the server
 * then refuses. The rules take an injected lister precisely so each side can
 * supply its own way of reading a directory, and the RULES stay one copy. No fs
 * or network in here; the caller brings both.
 */

export interface DirEntry {
  name: string;
  path: string;
  type: "file" | "dir";
}

/**
 * A dataset name from a directory name.
 *
 * Shared for the same reason the rules are: the CLI has to be able to say which
 * dataset it is publishing into, and the name it computes must be the one the
 * server computes, character for character.
 */
export function nameToSlug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "dataset"
  );
}

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

/** Lists one directory of the repo, "" being the root. */
export type DirLister = (path: string) => Promise<DirEntry[]>;

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
