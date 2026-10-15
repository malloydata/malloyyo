// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Branch-preview addresses and cache keys (src/lib/repo-previews.ts). Pure, so
// the parsing every route and tool relies on is tested without a database.

import { decodeDatasetRef } from "./repo-names";

/** `repo@ref:dataset`, split. Null when the string isn't one: no `@`, or not one `:`.
    Git refs can't contain `:` and repo slugs can't contain `@`, so this is exact. */
export function parsePreviewRef(raw: string): { repo: string; ref: string; dataset: string } | null {
  // A route segment arrives still percent-encoded (`%3A`), as every dataset
  // ref does; decode it the same way resolveDatasetRef does.
  const s = decodeDatasetRef(raw);
  const colon = s.indexOf(":");
  if (colon < 0 || s.indexOf(":", colon + 1) >= 0) return null;
  const left = s.slice(0, colon);
  const dataset = s.slice(colon + 1).trim();
  const at = left.indexOf("@");
  if (at <= 0 || at === left.length - 1 || !dataset) return null;
  return { repo: left.slice(0, at).trim(), ref: left.slice(at + 1).trim(), dataset };
}

/** The canonical address for a preview of one dataset. */
export function previewRef(repoSlug: string, branch: string, dataset: string): string {
  return `${repoSlug}@${branch}:${dataset}`;
}

/** The runtime cache key a preview serves under — stable per snapshot and dataset. */
export function previewModelId(revisionId: string, dir: string): string {
  return `preview:${revisionId}:${dir}`;
}

/** The dataset directory a preview cache key names, for `modelFileMap`. */
export function previewDirOf(modelId: string): string | null {
  const m = /^preview:[0-9a-f-]{36}:(.*)$/.exec(modelId);
  return m ? m[1] : null;
}

/** The model-shaped reference a preview cache key stands for — what the places
    that look a model up by id need, without a row. Null for any other id. */
export function previewModelRef(modelId: string): { id: string; source: string; revisionId: string; datasetId: string } | null {
  const m = /^preview:([0-9a-f-]{36}):(.*)$/.exec(modelId);
  return m ? { id: modelId, source: "", revisionId: m[1], datasetId: "" } : null;
}
