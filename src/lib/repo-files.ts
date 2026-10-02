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
 * The cache is keyed by revision id, which is immutable, so it never needs
 * invalidating — the same argument that makes `compiled_model_def`'s key
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

type Unpacked = {
  /** repo-relative path → text. Directory members dropped. */
  files: Map<string, string>;
  /** What the revision declared it publishes, for sibling exclusion. */
  dirs: string[];
};

const CACHE_MAX = 8;
const cache = new Map<string, Unpacked>();

function cacheGet(key: string): Unpacked | undefined {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

function cacheSet(key: string, value: Unpacked): void {
  cache.set(key, value);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Unpack a revision's archive, once per instance per revision. */
async function unpackRevision(revisionId: string): Promise<Unpacked | null> {
  const hit = cacheGet(revisionId);
  if (hit) return hit;
  const [rev] = await db
    .select({ archive: repoRevisions.archive, datasets: repoRevisions.datasets })
    .from(repoRevisions)
    .where(eq(repoRevisions.id, revisionId))
    .limit(1);
  if (!rev) return null;
  const members = unzipSync(new Uint8Array(rev.archive));
  const files = new Map<string, string>();
  for (const [name, bytes] of Object.entries(members)) {
    if (name.endsWith("/")) continue;
    files.set(name, strFromU8(bytes));
  }
  const out: Unpacked = { files, dirs: (rev.datasets ?? []).map((d) => d.dir) };
  cacheSet(revisionId, out);
  logger.debug("revision unpacked", { revisionId, files: files.size });
  return out;
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
    const unpacked = await unpackRevision(model.revisionId);
    if (unpacked) {
      const view = datasetView(unpacked.files.keys(), repoDir, unpacked.dirs);
      if ("error" in view) {
        // Verification refuses this, so reaching it means the revision was
        // stored by an older build. Fail loudly rather than serve a model whose
        // files are not the ones it compiled against.
        throw new Error(`revision ${model.revisionId}: ${view.error}`);
      }
      const out = new Map<string, string>();
      for (const [viewPath, repoPath] of view.files) {
        const text = unpacked.files.get(repoPath);
        if (text !== undefined) out.set(viewPath, text);
      }
      const config = await revisionConfig(unpacked, repoDir);
      if (config !== undefined) out.set("malloy-config.json", config);
      return out;
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

/**
 * The config that applies to one directory of a stored revision.
 *
 * `discoverConfigText` again — the same call the compile makes, with an
 * in-archive reader instead of a filesystem one. The walk is Malloy's, so "which
 * config file wins" has one answer wherever it is asked: the author's machine,
 * the verify, and here.
 */
async function revisionConfig(unpacked: Unpacked, repoDir: string): Promise<string | undefined> {
  const base = repoDir.replace(/^\/+|\/+$/g, "");
  const readURL = async (u: URL): Promise<string> => {
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, "");
    const text = unpacked.files.get(rel);
    if (text === undefined) throw new Error(`${rel} not in the revision`);
    return text;
  };
  const found = await discoverConfigText(
    readURL,
    new URL(`file:///${base ? `${base}/` : ""}`),
    new URL("file:///"),
  ).catch(() => ({ text: undefined }));
  return found.text;
}

export { CONFIG_NAMES };
