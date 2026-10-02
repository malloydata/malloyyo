// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * A SERVED MODEL'S FILES, out of the revision that produced it.
 *
 * Repo content is stored once, as the revision's zip. It is not copied into
 * `malloy_model_files` per dataset per version — which made "what is in this
 * repo" a question about a table, duplicated every shared `lib/` file into every
 * dataset of the repo, and left two records of the same bytes to disagree.
 *
 * So a revision-backed model's file map is derived, by the SAME `datasetView`
 * rule the compile workspace was built from. One rule, two renderings: on disk
 * for the compile, as a content map here. A model with no revision — a
 * Claude-authored one, or a single-dataset `--dataset x` push — still reads its
 * rows, so nothing historical had to be rewritten to land this.
 *
 * THE ZIP IS READ PARTIALLY, which is the whole reason it is a zip.
 *
 * A zip's central directory lists every member's name and uncompressed size
 * without inflating anything, so the path list comes out of one cheap pass and
 * only the members in THIS DATASET'S VIEW are then inflated. A four-dataset repo
 * does not pay for the other three, and a repo carrying committed data files
 * does not pay for them at all. `.tar.gz` can do none of this: gzip is one
 * stream, so the alternative was inflating the whole repo to serve one dataset.
 *
 * Both caches are keyed by revision id, which is immutable, so neither ever
 * needs invalidating — the same argument that makes `compiled_model_def`'s key
 * `malloy_models.id`.
 */

import { eq } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import { db, malloyModelFiles, repoRevisions } from "@/db";
import { logger } from "./logger";
import { CONFIG_NAMES, datasetView, discoverConfigText } from "./repo-workspace";

export type RevisionBackedModel = {
  id: string;
  revisionId: string | null;
  source: string;
};

/** A revision's central directory plus its bytes. Nothing inflated yet. */
type RevisionIndex = {
  zip: Uint8Array;
  /** Every FILE path in the repo, repo-relative. Directory members dropped. */
  paths: string[];
  /** What the revision declared it publishes, for sibling exclusion. */
  dirs: string[];
};

/** A small LRU. Two of them, so one revision's index is shared by its datasets. */
function lru<V>(max: number) {
  const m = new Map<string, V>();
  return {
    get(k: string): V | undefined {
      const hit = m.get(k);
      if (hit !== undefined) {
        m.delete(k);
        m.set(k, hit);
      }
      return hit;
    },
    set(k: string, v: V): void {
      m.set(k, v);
      while (m.size > max) {
        const oldest = m.keys().next().value;
        if (oldest === undefined) break;
        m.delete(oldest);
      }
    },
  };
}

const indexes = lru<RevisionIndex>(4);
const views = lru<Map<string, string>>(16);

/**
 * A revision's path list, WITHOUT inflating a byte.
 *
 * `unzipSync`'s filter is called once per member with the name and the declared
 * sizes from the central directory; returning false skips the inflation. So this
 * walks the whole repo and decompresses none of it.
 */
async function revisionIndex(revisionId: string): Promise<RevisionIndex | null> {
  const hit = indexes.get(revisionId);
  if (hit) return hit;
  const [rev] = await db
    .select({ archive: repoRevisions.archive, datasets: repoRevisions.datasets })
    .from(repoRevisions)
    .where(eq(repoRevisions.id, revisionId))
    .limit(1);
  if (!rev) return null;
  const zip = new Uint8Array(rev.archive);
  const paths: string[] = [];
  unzipSync(zip, {
    filter: (file) => {
      if (!file.name.endsWith("/")) paths.push(file.name);
      return false;
    },
  });
  const index: RevisionIndex = { zip, paths, dirs: (rev.datasets ?? []).map((d) => d.dir) };
  indexes.set(revisionId, index);
  logger.debug("revision indexed", { revisionId, paths: paths.length, bytes: zip.length });
  return index;
}

/**
 * The file map a model is served from.
 *
 * `index.malloy` at the root, the dataset's own `dashboards/`, the repo's shared
 * files at their repo-relative paths, and `malloy-config.json` — the one the
 * compile used, found by Malloy's own discovery over the archive.
 */
export async function modelFilesFor(
  model: RevisionBackedModel,
  repoDir: string,
): Promise<Map<string, string>> {
  if (model.revisionId) {
    const cached = views.get(`${model.revisionId}:${repoDir}`);
    if (cached) return new Map(cached);
    const index = await revisionIndex(model.revisionId);
    if (index) {
      const built = await buildView(index, repoDir, model.revisionId);
      views.set(`${model.revisionId}:${repoDir}`, built);
      return new Map(built);
    }
    logger.warn("revision archive missing — falling back to stored file rows", {
      modelId: model.id,
      revisionId: model.revisionId,
    });
  }

  const rows = await db
    .select({ path: malloyModelFiles.path, content: malloyModelFiles.content })
    .from(malloyModelFiles)
    .where(eq(malloyModelFiles.modelId, model.id));
  if (rows.length > 0) return new Map(rows.map((f) => [f.path, f.content]));
  return new Map([["index.malloy", model.source]]);
}

async function buildView(
  index: RevisionIndex,
  repoDir: string,
  revisionId: string,
): Promise<Map<string, string>> {
  const view = datasetView(index.paths, repoDir, index.dirs);
  if ("error" in view) {
    // Verification refuses this, so reaching it means the revision was stored
    // by an older build. Fail loudly rather than serve a model whose files are
    // not the ones it compiled against.
    throw new Error(`revision ${revisionId}: ${view.error}`);
  }

  // Inflate THIS DATASET'S members, and the config candidates the walk below
  // may ask for. Everything else stays compressed.
  const wanted = new Set(view.files.values());
  for (const path of index.paths) {
    if ((CONFIG_NAMES as readonly string[]).includes(path.split("/").pop() ?? "")) wanted.add(path);
  }
  const members = unzipSync(index.zip, { filter: (file) => wanted.has(file.name) });

  const out = new Map<string, string>();
  for (const [viewPath, repoPath] of view.files) {
    const bytes = members[repoPath];
    if (bytes !== undefined) out.set(viewPath, strFromU8(bytes));
  }
  const config = await revisionConfig(members, repoDir);
  if (config !== undefined) out.set("malloy-config.json", config);
  return out;
}

/**
 * The config that applies to one directory of a stored revision.
 *
 * `discoverConfigText` again — the same call the compile makes, with an
 * in-archive reader instead of a filesystem one. The walk is Malloy's, so "which
 * config file wins" has one answer wherever it is asked: the author's machine,
 * the verify, and here.
 */
async function revisionConfig(
  members: Record<string, Uint8Array>,
  repoDir: string,
): Promise<string | undefined> {
  const base = repoDir.replace(/^\/+|\/+$/g, "");
  const readURL = async (u: URL): Promise<string> => {
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, "");
    const bytes = members[rel];
    if (bytes === undefined) throw new Error(`${rel} not in the revision`);
    return strFromU8(bytes);
  };
  const found = await discoverConfigText(
    readURL,
    new URL(`file:///${base ? `${base}/` : ""}`),
    new URL("file:///"),
  ).catch(() => ({ text: undefined }));
  return found.text;
}

export { CONFIG_NAMES };
