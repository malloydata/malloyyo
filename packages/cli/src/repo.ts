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
import { layoutFromListing, type DirEntry, type DirLister } from "@malloyyo/mcp-engine";
import { discoverDashboards, type Dashboard } from "./discover.js";
import { makeRunner, type ModelRunner } from "./host.js";

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
  const layout = await layoutFromListing(fsLister(root), root);
  if (!layout.ok) throw new Error(layout.error);

  const units =
    layout.kind === "single"
      ? [{ dataset: "", dir: "" }]
      : layout.datasets.map((d) => ({ dataset: d.name, dir: d.dir }));
  const multi = units.length > 1 || units.some((u) => u.dir !== "");

  const runners: ModelRunner[] = [];
  const dashboards: RepoDashboard[] = [];
  try {
    for (const u of units) {
      const modelRoot = u.dir ? path.join(root, u.dir) : root;
      const runner = await makeRunner(modelRoot);
      runners.push(runner);
      if (!runner.entryExists()) {
        throw new Error(
          multi
            ? `${u.dir}/index.malloy is missing — every directory under datasets/ is a dataset and needs one.`
            : `No index.malloy at ${root} — run this from a Malloy model repo, or ask claude to add a dataset.`,
        );
      }
      for (const d of await discoverDashboards(modelRoot, runner)) {
        dashboards.push({
          ...d,
          dataset: u.dataset,
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
