// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * HOW THE SERVER SEES ONE DATASET OF A REPO.
 *
 * "`malloyyo lint` blesses a repo the server then refuses" is the defining bug
 * of multi-dataset repos, and across three reviews almost every instance of it
 * was the same shape: an in-memory file map on the server against a real
 * directory tree on the author's machine. `Dirent.isDirectory()` does not follow
 * a symlink while `statSync` does; an extractor dropped zero-length members so
 * `touch index.malloy` made a dataset stop existing; directories were inferred
 * only from the files that were kept; and a config search checked two locations
 * where Malloy's own `discoverConfig` walks every intermediate one — under a
 * comment asserting the two could not disagree.
 *
 * The fix is not more care at each site. It is to have ONE mechanism:
 *
 *   1. the revision's zip is written to a real temp directory (repo-archive.ts);
 *   2. the layout rules run over that directory with a filesystem lister;
 *   3. each dataset gets its own temp directory holding its VIEW of the repo —
 *      its own files at the root, the repo's shared files at their repo-relative
 *      paths — so the model root is `index.malloy`, as every consumer downstream
 *      already assumes;
 *   4. the config is found by calling Malloy's `discoverConfig`. Not a
 *      reimplementation of it, and not an assertion that we match it: the
 *      function itself, over the same filesystem, with the repo root as ceiling,
 *      which is exactly how the CLI calls it.
 *   5. the compile reads that directory through a plain filesystem URLReader.
 *
 * The view is a PURE FUNCTION of the path list (`datasetView`), so the same rule
 * produces the compile workspace on disk and the stored model's file map out of
 * the zip. Two renderings, one rule.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import * as malloy from "@malloydata/malloy";
import { DATASETS_DIR, ENTRY_FILE, type DirEntry, type DirLister } from "@malloyyo/mcp-engine";
import { logger } from "./logger";

/** Both names Malloy's own discovery looks for, in its order of preference. */
export const CONFIG_NAMES = ["malloy-config-local.json", "malloy-config.json"] as const;

/**
 * List a directory of a materialized repo, `""` being its root.
 *
 * `statSync`, not `Dirent.isDirectory()`. The CLI's two readers disagreed on
 * exactly this — its lister did not follow symlinks while its archive walker
 * did, so a repo that symlinked a dataset directory linted as empty and
 * published two datasets. `statSync` follows, which is the answer a compiler
 * gets when it opens the file, so it is the answer the layout rules should get
 * too.
 *
 * A SYMLINKED DATASET DIRECTORY STILL DOES NOT WORK SERVER-SIDE, and this
 * function is not what fixes it. Git stores the link rather than the target, so
 * GitHub's zipball delivers `datasets/sales` as a regular FILE whose contents
 * are `../real/sales`; `materializeArchive` writes a file, and the layout rules
 * see no dataset there. The failure is at least a refusal and not a silent
 * half-publish — `datasets/` with no qualifying subdirectory is reported as
 * such — but `malloyyo lint` on the author's disk follows the link and sees a
 * dataset, so this is the one shape where lint and the server still disagree.
 * Fixing it means teaching the materializer to re-create links, and it is not
 * done; said here rather than left for someone to discover.
 */
export function fsLister(root: string): DirLister {
  return async (p: string): Promise<DirEntry[]> => {
    const dir = p ? path.join(root, p) : root;
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const out: DirEntry[] = [];
    for (const name of names) {
      let st: fs.Stats;
      try {
        st = fs.statSync(path.join(dir, name));
      } catch {
        continue; // a broken symlink is neither a file nor a directory
      }
      if (!st.isDirectory() && !st.isFile()) continue;
      out.push({
        name,
        path: p ? `${p}/${name}` : name,
        type: st.isDirectory() ? "dir" : "file",
      });
    }
    return out;
  };
}

/** A URLReader over a real directory. `file:///x/y` reads `<root>/x/y`. */
export class WorkspaceURLReader implements malloy.URLReader {
  /** Every path the compiler actually asked for — the transitive closure. */
  readonly fetched = new Map<string, string>();

  constructor(private readonly root: string) {}

  async readURL(u: URL): Promise<string> {
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, "");
    if (rel.split("/").some((s) => s === "..")) {
      throw new Error(`${rel}: outside the model root`);
    }
    const text = await fs.promises.readFile(path.join(this.root, rel), "utf8");
    this.fetched.set(rel, text);
    return text;
  }
}

export type DatasetView = {
  /** view path (what the model sees) → repo-relative path (what is stored). */
  files: Map<string, string>;
};

export type DatasetViewResult = DatasetView | { error: string };

/**
 * One dataset's view of the repo.
 *
 * `datasets/finance/index.malloy` becomes `index.malloy`; a shared
 * `lib/orders.malloy` keeps its repo-root path, which is exactly what
 * `import "../../lib/orders.malloy"` resolves to from the re-rooted entry,
 * because URL resolution clamps `..` at the root. So a multi-dataset repo
 * produces a file set indistinguishable from a single-dataset repo's — which is
 * the point: threading a per-dataset entry path through the MCP query path,
 * dashboards, drafts and the restricted-query gate would put a new variable in
 * the middle of every one of them.
 *
 * SIBLING DATASETS ARE EXCLUDED. `datasets/sales/` is not this dataset's
 * business, and a dashboard bundle that inlined it would ship one dataset's
 * model to another's readers.
 *
 * `malloy-config*.json` is excluded everywhere and supplied separately, because
 * nearest-wins is its rule (see `discoverRepoConfig`) and the generic collision
 * refusal below would call that an error.
 */
export function datasetView(
  /** Every FILE path in the repo, repo-relative. Directories are not needed. */
  paths: Iterable<string>,
  /** This dataset's directory; `""` is the repo root. */
  dir: string,
  /** Every dataset directory the revision publishes, including this one. */
  datasetDirs: Iterable<string>,
): DatasetViewResult {
  const base = dir.replace(/^\/+|\/+$/g, "");
  const siblings = [...datasetDirs]
    .map((d) => d.replace(/^\/+|\/+$/g, ""))
    .filter((d) => d && d !== base);

  const files = new Map<string, string>();
  const collisions: string[] = [];
  for (const repoPath of paths) {
    const name = repoPath.split("/").pop() ?? "";
    if ((CONFIG_NAMES as readonly string[]).includes(name)) continue;
    if (siblings.some((s) => repoPath === s || repoPath.startsWith(`${s}/`))) continue;
    const viewPath =
      base && repoPath.startsWith(`${base}/`) ? repoPath.slice(base.length + 1) : repoPath;
    if (!viewPath) continue;
    // EVERY TIE IS REFUSED, so there is no tie-break to write. A previous
    // version of this loop also carried a "the dataset's own file wins" clause,
    // which could never run — the refusal below fires on any collision at all.
    // An unreachable resolution rule reads as the behaviour, which is worse
    // than not having one.
    if (files.has(viewPath)) collisions.push(viewPath);
    files.set(viewPath, repoPath);
  }
  if (collisions.length > 0) {
    return {
      error:
        `${[...new Set(collisions)].sort().join(", ")}: this dataset's directory and the repo root ` +
        `both contain ${collisions.length > 1 ? "these paths" : "this path"}, so one would hide ` +
        `the other. Rename one of them.`,
    };
  }
  return { files };
}

/**
 * The repo's `malloy-config.json` for one dataset, by MALLOY'S OWN RULE.
 *
 * `discoverConfig` walks up from the model root to the ceiling, preferring
 * `malloy-config-local.json` at each level, and stops at the ceiling inclusive.
 * This calls that function — over the materialized repo, with the repo root as
 * the ceiling, which is how `makeRunner` calls it for the CLI. The two cannot
 * disagree about which file wins, because there is only one implementation of
 * the question.
 *
 * Returns the matched file's TEXT, because that is what the compile path takes
 * (`introspectModelWithReader`'s `configJson`) and what gets re-read when a
 * dataset is served later.
 */
export async function discoverConfigText(
  /** Reads one URL. A filesystem reader for a materialized repo, an in-archive
      one for a stored revision - the WALK is the same either way. */
  readURL: (u: URL) => Promise<string>,
  /** The dataset's directory, as a URL ending in `/`. */
  startURL: URL,
  /** The repo root, as a URL ending in `/`. Discovery stops here, inclusive. */
  ceilingURL: URL,
): Promise<{ text?: string; from?: string }> {
  let config: malloy.MalloyConfig | null = null;
  try {
    config = await malloy.discoverConfig(startURL, ceilingURL, { readURL } as malloy.URLReader);
  } catch (err) {
    // A config file that matched but would not parse. Malloy throws rather than
    // walking past it, and so does this: the alternative is compiling with no
    // connections and reporting a baffling "no connection named" instead.
    throw new Error(
      `malloy-config.json could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!config) return {};
  // `readOverlay` is ASYNC. Reading it without awaiting hands back a Promise,
  // `typeof` says "object", and the function silently reports "no config" - a
  // repo compiling with no connections at all and a baffling "no connection
  // named" instead of a missing-file message.
  const configURL = await config.readOverlay("config", "configURL");
  if (typeof configURL !== "string") return {};
  const matched = new URL(configURL);
  const text = await readURL(matched);
  const from = matched.href.startsWith(ceilingURL.href)
    ? decodeURIComponent(matched.href.slice(ceilingURL.href.length))
    : matched.href;
  return { text, from };
}

/** `discoverConfigText` over a materialized repo on disk. */
export async function discoverRepoConfig(
  repoRoot: string,
  dir: string,
): Promise<{ text?: string; from?: string }> {
  const base = dir.replace(/^\/+|\/+$/g, "");
  const abs = path.resolve(repoRoot);
  return discoverConfigText(
    async (u) => fs.promises.readFile(url.fileURLToPath(u), "utf8"),
    url.pathToFileURL((base ? path.join(abs, base) : abs) + path.sep),
    url.pathToFileURL(abs + path.sep),
  );
}

/**
 * Write one dataset's workspace: its view of the repo, plus the config that
 * applies to it, on a real disk with `index.malloy` at the root.
 *
 * The compile then needs nothing but a filesystem reader. That is the whole
 * argument for doing it this way rather than assembling a file map: there is one
 * resolution mechanism, and it is the one the author's machine uses.
 */
export function writeDatasetWorkspace(
  repoRoot: string,
  view: DatasetView,
  config: { text?: string } = {},
): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "malloyyo-ds-"));
  for (const [viewPath, repoPath] of view.files) {
    const dest = path.join(ws, viewPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, repoPath), dest);
  }
  if (config.text !== undefined) {
    fs.writeFileSync(path.join(ws, "malloy-config.json"), config.text);
  }
  logger.debug("dataset workspace written", { ws, files: view.files.size, config: config.text !== undefined });
  return ws;
}

export { DATASETS_DIR, ENTRY_FILE };
