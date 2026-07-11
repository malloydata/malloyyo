// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Artifact (dashboard) discovery: a model DECLARES its dashboards by tagging a
// query with `# artifact` (optionally `# artifact title="…" name="…"`, flat or
// nested `# artifact { title="…" }`). There is no manifest file — the tag is
// the manifest. Two declaration sites are supported:
//   - a top-level `query:` (the original form), and
//   - a `view:` inside a source (the idiomatic form — reusable, nestable,
//     explorable through the normal MCP surface).
// Either way the artifact carries a `query` run-expression (`<queryName>` or
// `<source> -> <view>`) that everything downstream runs as `run: <query>` — so
// the two forms share one execution/given-specs path.
// `./dashboards/<name>/Dashboard.tsx` optionally customizes the component;
// without one the runtime renders its default dashboard (auto controls from
// the given specs + the result panel).
//
// The tag is deliberately NOT `# dashboard` — that's a Malloy *renderer* tag
// (dashboard result layout) and tagging a query with it would change how the
// result renders.

import type { Runtime } from '@malloydata/malloy';

export interface ArtifactInfo {
  /** Slug (directory name for a custom Dashboard.tsx, URL segment). Defaults
      to the query/view name; override with `# artifact name="…"`. */
  name: string;
  /** Run-expression handed to `run:` — a top-level query name, or a
      `<source> -> <view>` path for a view artifact. */
  query: string;
  /** For a view artifact: the source that holds the view. Absent for a
      top-level `query:` artifact. */
  source?: string;
  /** For a view artifact: the view's name. Absent for a top-level query. */
  view?: string;
  /** Human title: `# artifact title="…"`, else the declaration's `#"` doc
      comment's first line, else the query/view name. */
  title: string;
  description?: string;
  /** Per-dashboard given defaults — `# artifact { givens { X="…" } }`. Two
      dashboards can share a given but land on different starting values;
      these override the declaration defaults (URL params still win). */
  givens?: Record<string, string | number | boolean>;
  /** Whether a control change re-runs the query immediately (the default) or
      is staged behind an Apply button. `# artifact { autorun=false }` opts a
      dashboard into the staged/Apply model; omitted or `autorun=true` = live.
      Only carried when explicitly `false` (the runtime treats absent as live). */
  autorun?: boolean;
}

/** How a candidate declaration identifies itself to `readArtifactTag`. */
interface ArtifactIdent {
  /** Run-expression: a top-level query name or `<source> -> <view>`. */
  runExpr: string;
  /** Slug/title default when `# artifact` supplies no `name=`/`title=`. */
  defaultName: string;
  /** Set for view artifacts (surfaced on ArtifactInfo). */
  source?: string;
  view?: string;
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

/** Read one declaration's `# artifact` tag; undefined when untagged. `ident`
    supplies the run-expression and slug/title defaults — the same reader
    serves both top-level `query:` and `view:` declarations. */
export function readArtifactTag(ident: ArtifactIdent, q: Tagged): ArtifactInfo | undefined {
  let tag: TagLike;
  try {
    tag = q.annotations.parseAsTag().tag;
  } catch {
    return undefined;
  }
  if (!tag.has('artifact')) return undefined;
  const nested = tag.tag('artifact');
  const description = docText(q);
  const name = nested?.text('name') ?? tag.text('name') ?? ident.defaultName;
  const title =
    nested?.text('title') ?? tag.text('title') ?? description?.split('\n')[0] ?? ident.defaultName;
  const info: ArtifactInfo = { name, query: ident.runExpr, title };
  if (ident.source) info.source = ident.source;
  if (ident.view) info.view = ident.view;
  if (description) info.description = description;
  // `autorun=false` stages control changes behind an Apply button; live is the
  // default, so only carry the flag when explicitly turned off.
  const autorunText = nested?.text('autorun') ?? tag.text('autorun');
  if (autorunText === 'false') info.autorun = false;
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

/** Structural subset of a source's view field. */
type QueryFieldLike = Tagged & { name: string };
type FieldLike = { name: string; isQueryField(): boolean };
type ExploreLike = { name: string; allFields: FieldLike[] };
type ModelLike = {
  queries(): { named: readonly string[] };
  getPreparedQueryByName(name: string): unknown;
  explores: ExploreLike[];
};

/**
 * All `# artifact`-tagged declarations in the model — the model's dashboard
 * list. Scans both top-level named queries and each source's views (a view is
 * the idiomatic form). Never throws on user input; compile failure comes back
 * as {ok:false}.
 */
export async function artifactQueries(runtime: Runtime, entry: URL): Promise<ArtifactsResult> {
  try {
    const model = (await runtime.loadModel(entry).getModel()) as unknown as ModelLike;
    const artifacts: ArtifactInfo[] = [];
    // Top-level `query: … # artifact` declarations.
    for (const queryName of model.queries().named) {
      const pq = model.getPreparedQueryByName(queryName) as unknown as Tagged;
      const info = readArtifactTag({ runExpr: queryName, defaultName: queryName }, pq);
      if (info) artifacts.push(info);
    }
    // `view: … # artifact` declarations inside each source. The run-expression
    // is `<source> -> <view>`, which `run:` accepts just like a query name.
    for (const src of model.explores) {
      for (const field of src.allFields) {
        if (!field.isQueryField()) continue;
        const view = field as unknown as QueryFieldLike;
        const info = readArtifactTag(
          {
            runExpr: `${src.name} -> ${view.name}`,
            defaultName: view.name,
            source: src.name,
            view: view.name,
          },
          view,
        );
        if (info) artifacts.push(info);
      }
    }
    return { ok: true, artifacts };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
