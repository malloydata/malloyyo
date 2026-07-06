// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Artifact (dashboard) discovery: a model DECLARES its dashboards by tagging a
// top-level query with `# artifact` (optionally `# artifact title="…" name="…"`,
// flat or nested `# artifact { title="…" }`). There is no manifest file — the
// tag is the manifest. `./dashboards/<name>/Dashboard.tsx` optionally customizes
// the component; without one the runtime renders its default dashboard (auto
// controls from the query's given specs + the result panel).
//
// The tag is deliberately NOT `# dashboard` — that's a Malloy *renderer* tag
// (dashboard result layout) and tagging a query with it would change how the
// result renders.

import type { Runtime } from '@malloydata/malloy';

export interface ArtifactInfo {
  /** Slug (directory name for a custom Dashboard.tsx, URL segment). Defaults
      to the query name; override with `# artifact name="…"`. */
  name: string;
  /** The tagged top-level query this dashboard runs. */
  query: string;
  /** Human title: `# artifact title="…"`, else the query's `#"` doc comment's
      first line, else the query name. */
  title: string;
  description?: string;
  /** Per-dashboard given defaults — `# artifact { givens { X="…" } }`. Two
      dashboards can share a given but land on different starting values;
      these override the declaration defaults (URL params still win). */
  givens?: Record<string, string | number | boolean>;
}

export type ArtifactsResult =
  | { ok: true; artifacts: ArtifactInfo[] }
  | { ok: false; error: string };

/** Structural subset of the foundation PreparedQuery annotation surface. */
type Tagged = {
  annotations: {
    forRoute(route?: string): Array<{ content: string }>;
    parseAsTag(route?: string): { tag: TagLike };
  };
};

type TagLike = {
  has(...path: string[]): boolean;
  text(...path: string[]): string | undefined;
  tag(...path: string[]): TagLike | undefined;
  dict: Record<string, { eq?: unknown }>;
};

function docText(t: Tagged): string | undefined {
  try {
    const docs = t.annotations
      .forRoute('"')
      .map((n) => n.content.trim())
      .filter(Boolean);
    return docs.length ? docs.join('\n') : undefined;
  } catch {
    return undefined;
  }
}

/** Read one query's `# artifact` declaration; undefined when untagged. */
export function readArtifactTag(queryName: string, q: Tagged): ArtifactInfo | undefined {
  let tag: TagLike;
  try {
    tag = q.annotations.parseAsTag().tag;
  } catch {
    return undefined;
  }
  if (!tag.has('artifact')) return undefined;
  const nested = tag.tag('artifact');
  const description = docText(q);
  const name = nested?.text('name') ?? tag.text('name') ?? queryName;
  const title =
    nested?.text('title') ?? tag.text('title') ?? description?.split('\n')[0] ?? queryName;
  const info: ArtifactInfo = { name, query: queryName, title };
  if (description) info.description = description;
  const givensTag = tag.tag('artifact', 'givens');
  if (givensTag) {
    const givens: Record<string, string | number | boolean> = {};
    for (const [key, t] of Object.entries(givensTag.dict ?? {})) {
      const eq = t.eq;
      if (typeof eq === 'string' || typeof eq === 'number' || typeof eq === 'boolean') {
        givens[key] = eq;
      }
    }
    if (Object.keys(givens).length) info.givens = givens;
  }
  return info;
}

/**
 * All `# artifact`-tagged named queries in the model — the model's dashboard
 * list. Never throws on user input; compile failure comes back as {ok:false}.
 */
export async function artifactQueries(runtime: Runtime, entry: URL): Promise<ArtifactsResult> {
  try {
    const model = await runtime.loadModel(entry).getModel();
    const artifacts: ArtifactInfo[] = [];
    for (const queryName of model.queries().named) {
      const pq = model.getPreparedQueryByName(queryName) as unknown as Tagged;
      const info = readArtifactTag(queryName, pq);
      if (info) artifacts.push(info);
    }
    return { ok: true, artifacts };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
