// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * What a repo publishes, for the commands that render it.
 *
 * `dashboard dev` and `dashboard bundle` both used to be "one model root, one
 * list of dashboards". A repo now holds a dataset per directory under
 * `datasets/`, and both commands should show all of it — the repo is what you
 * work on, and the command shouldn't change because the repo grew a second
 * dataset.
 *
 * A single-dataset repo comes back as ONE unnamed unit, and every slug is just
 * the dashboard name — so existing repos, their URLs, and the static sites
 * already published from them are untouched.
 */

import fs from "node:fs";
import path from "node:path";
import {
  datasetTitle,
  layoutFromListing,
  DATASETS_DIR,
  type DirEntry,
  type DirLister,
} from "@malloyyo/mcp-engine";
import { discoverDashboards, type Dashboard } from "./discover.js";
import type { SwitcherDataset } from "./shared/nav.js";
import { makeRunner, type ModelRunner } from "./host.js";

/**
 * Directories a repo's own files are never in, at any depth.
 *
 * Only these two, and deliberately. `docs` and `dist` were here for one release
 * and were a mistake: this set is matched by BASENAME at every level, while
 * nothing else in the system excludes those names, so a dataset legitimately
 * called `datasets/docs/` was listed by the layout rules, counted by the CLI,
 * and then packed into the archive with none of its files — a silent
 * half-publish reporting success. It also dropped `docs/shared.malloy` from a
 * single-dataset repo that imported it, which compiles here and not on the
 * server.
 *
 * What those names were reaching for is "the static site `dashboard bundle`
 * emitted", and that is `isBundleOutput`'s job: it asks what a directory
 * CONTAINS, so it is right at any depth and wherever `-o` put it.
 */
export const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git"]);

/**
 * The file `dashboard bundle` writes into every site it emits.
 *
 * `SKIP_DIRS` covers the directory the instructions tell authors to commit, but
 * `-o` takes any directory and nothing persists the choice — so a walker also
 * recognises an emitted site by what the bundler put in it, rather than by where
 * the author happened to put it.
 */
const BUNDLE_MARKER = ["assets", "model-files.js"] as const;

/** Is this directory an emitted static site rather than part of the repo? */
export function isBundleOutput(dir: string): boolean {
  return fs.existsSync(path.join(dir, ...BUNDLE_MARKER));
}

/**
 * The repo root above a model root.
 *
 * `malloy-config.json` at the repo root is shared by every dataset, and the
 * config search needs the repo root as its ceiling to find it. Commands are
 * pointed at a DATASET directory often enough that the ceiling cannot just be
 * whatever was typed — `malloyyo init` prints `dashboard dev -C datasets/<name>`
 * as the next thing to run, and `lint datasets/<name>` is documented as working.
 * A directory whose parent is `datasets/` is a dataset, so the repo is its
 * grandparent.
 *
 * Evidence is required, not just the name: a perfectly ordinary repo can be
 * checked out at `~/work/datasets/thing`, and walking up out of it would hand
 * the config search a stranger's `malloy-config.json`. A repo root is where the
 * git checkout or the shared config is; with neither, the directory we were
 * given is its own root, which is what every single-dataset repo is.
 */
export function repoRootOf(modelRoot: string): string {
  const abs = path.resolve(modelRoot);
  // ITS OWN checkout wins, before anything above is considered. A model repo
  // cloned to `~/work/datasets/mymodel` is a repo that happens to sit in a
  // directory called `datasets`, and walking up out of it made it unpublishable
  // — while the advice the refusal printed would have published the unrelated
  // container above it under the repo's name. `.git` is a FILE in a worktree or
  // submodule, which `existsSync` matches either way.
  if (fs.existsSync(path.join(abs, ".git"))) return abs;
  const parent = path.dirname(abs);
  if (path.basename(parent) !== DATASETS_DIR) return abs;
  const above = path.dirname(parent);
  const isRepo =
    fs.existsSync(path.join(above, ".git")) ||
    fs.existsSync(path.join(above, "malloy-config.json"));
  return isRepo ? above : abs;
}

/** Read a directory of the repo on disk, "" being its root. Missing is empty. */
export function fsLister(root: string): DirLister {
  return async (p: string): Promise<DirEntry[]> => {
    const dir = p ? path.join(root, p) : root;
    if (!fs.existsSync(dir)) return [];
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isDirectory() || e.isFile())
      .map((e) => ({
        name: e.name,
        path: p ? `${p}/${e.name}` : e.name,
        type: e.isDirectory() ? ("dir" as const) : ("file" as const),
      }));
  };
}

export type RepoDashboard = Dashboard & {
  /** The dataset it belongs to; "" in a single-dataset repo. */
  dataset: string;
  /** What that dataset is CALLED — `## dataset { title= }`, else derived from
      the name. "" in a single-dataset repo, which shows no dataset. */
  datasetLabel: string;
  /**
   * How it is addressed: the dashboard name on its own in a single-dataset
   * repo, `<dataset>/<name>` otherwise. Dev routes `?d=` on it and bundle names
   * its file after it, so a repo that gains a second dataset does not rename
   * the pages of the first.
   */
  slug: string;
  /** The runner for THIS dashboard's dataset. */
  runner: ModelRunner;
  /** Its model root — the dataset's directory, or the repo root when single. */
  root: string;
  /**
   * `entryFile`, relative to the REPO.
   *
   * `entryFile` is relative to the dataset, which is what its own runner wants.
   * A bundle inlines every model file in the repo under repo-relative keys and
   * ships one map to the browser, so the entry it names has to be keyed the same
   * way or the runtime looks up a path that is not there.
   */
  repoEntryFile?: string;
};

export type RepoDashboards = {
  /** More than one dataset, so slugs are qualified and the nav groups. */
  multi: boolean;
  dashboards: RepoDashboard[];
  dispose(): Promise<void>;
};

/**
 * Every dashboard the repo publishes, with the runner each one needs.
 *
 * Discovery has to COMPILE each dataset to find its `# artifact` tags, so a
 * repo with four datasets takes four compiles to start. There is no lazy
 * version worth having: the nav cannot list what has not been compiled.
 */
export async function discoverRepoDashboards(root: string): Promise<RepoDashboards> {
  const repoRoot = repoRootOf(root);
  const layout = await layoutFromListing(fsLister(root), root);
  if (!layout.ok) throw new Error(layout.error);

  const units =
    layout.kind === "single"
      ? [{ dataset: "", dir: "" }]
      : layout.datasets.map((d) => ({ dataset: d.name, dir: d.dir }));
  const multi = units.length > 1 || units.some((u) => u.dir !== "");

  const runners: ModelRunner[] = [];
  const dashboards: RepoDashboard[] = [];
  const titleOf = new Map<string, string | undefined>();
  try {
    for (const u of units) {
      const modelRoot = u.dir ? path.join(root, u.dir) : root;
      // The repo root is the ceiling for the config search: `malloy-config.json`
      // lives there and its connections belong to every dataset. It is not
      // necessarily what we were pointed AT — `-C datasets/sales` is a dataset.
      const runner = await makeRunner(modelRoot, { repoRoot });
      runners.push(runner);
      if (!runner.entryExists()) {
        throw new Error(
          multi
            ? `${u.dir}/index.malloy is missing — every directory under datasets/ is a dataset and needs one.`
            : `No index.malloy at ${root} — run this from a Malloy model repo, or ask claude to add a dataset.`,
        );
      }
      if (u.dataset) titleOf.set(u.dataset, (await runner.datasetMeta()).title);
      for (const d of await discoverDashboards(modelRoot, runner)) {
        dashboards.push({
          ...d,
          dataset: u.dataset,
          datasetLabel: u.dataset ? datasetTitle(u.dataset, titleOf.get(u.dataset)) : "",
          slug: multi ? `${u.dataset}/${d.name}` : d.name,
          runner,
          root: modelRoot,
          repoEntryFile: d.entryFile && u.dir ? `${u.dir}/${d.entryFile}` : d.entryFile,
        });
      }
    }
  } catch (e) {
    await Promise.all(runners.map((r) => r.dispose().catch(() => {})));
    throw e;
  }

  return {
    multi,
    dashboards,
    dispose: async () => {
      await Promise.all(runners.map((r) => r.dispose().catch(() => {})));
    },
  };
}

/**
 * The switcher's tree: a branch per dataset, its dashboards under it.
 *
 * Here, not in `dashboard.ts` and again in `bundle.ts`, because the slug is
 * built here — and the two copies of this that existed differed from the
 * switcher's own idea of a slug, which emitted links to pages that did not
 * exist.
 */
export function navTree(all: RepoDashboard[]): SwitcherDataset[] {
  const byDataset = new Map<string, RepoDashboard[]>();
  for (const d of all) byDataset.set(d.dataset, [...(byDataset.get(d.dataset) ?? []), d]);
  return [...byDataset.entries()].map(([dataset, ds]) => ({
    dataset,
    title: ds[0]?.datasetLabel || undefined,
    dashboards: ds.map((d) => ({
      slug: d.slug,
      title: d.title || d.name,
      ...(d.description ? { description: d.description } : {}),
    })),
  }));
}
