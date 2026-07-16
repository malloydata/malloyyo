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
      `<source> -> <view>` path for a view artifact. Empty string for a
      COMPOSITE artifact (see `tiles`) — it has no single run-expression. */
  query: string;
  /** Composite dashboard: the tile run-expressions (each a query name or a
      `<source> -> <view>` path), in declaration order. Present iff this is a
      composite artifact — declared `## artifact { tiles=[…] }` at model scope
      (cross-source) or `# artifact { tiles=[…] }` on a source (its own views).
      When set, `query` is "" and the tiles are run separately and combined into
      one `# dashboard` result. */
  tiles?: string[];
  /** Composite only: pass-through to the dashboard nest's `columns`; omitted
      lets the renderer choose. `## artifact { dashboard_columns=3 }`. */
  dashboard_columns?: number;
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
  textArray(...path: string[]): string[] | undefined;
  numeric(...path: string[]): number | undefined;
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

/** A tile string → a run-expression. At a SOURCE site (`source` set) a bare
    identifier is one of that source's views, so it becomes `<source> -> <view>`;
    an already-arrowed tile (or any tile at the model site) passes through. */
function resolveTile(tile: string, source?: string): string {
  const t = tile.trim();
  if (source && !t.includes('->')) return `${source} -> ${t}`;
  return t;
}

/** Read the per-dashboard given defaults off `# artifact { givens { … } }`. */
function readGivens(tag: TagLike): Record<string, string | number | boolean> | undefined {
  const givensTag = tag.tag('artifact', 'givens');
  if (!givensTag) return undefined;
  const givens: Record<string, string | number | boolean> = {};
  for (const [key, t] of Object.entries(givensTag.dict ?? {})) {
    const eq = t.eq;
    if (typeof eq === 'string' || typeof eq === 'number' || typeof eq === 'boolean') {
      givens[key] = eq;
    }
  }
  return Object.keys(givens).length ? givens : undefined;
}

/** Read one declaration's `# artifact` tag; undefined when untagged. `ident`
    supplies the run-expression and slug/title defaults — the same reader serves
    top-level `query:`, `view:`, a `source:` (composite), and the model
    (`## artifact`, composite). A `tiles=[…]` list makes it a composite. */
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

  // Composite: `tiles=[…]`. Each tile resolves to a run-expression (bare views
  // scoped to the declaring source); `query` is empty — there is no single one.
  const rawTiles = nested?.textArray('tiles') ?? tag.textArray('tiles');
  if (rawTiles && rawTiles.length) {
    const info: ArtifactInfo = {
      name,
      query: '',
      title,
      tiles: rawTiles.map((t) => resolveTile(t, ident.source)),
    };
    if (ident.source) info.source = ident.source;
    if (description) info.description = description;
    const cols = nested?.numeric('dashboard_columns') ?? tag.numeric('dashboard_columns');
    if (typeof cols === 'number') info.dashboard_columns = cols;
    const autorunText = nested?.text('autorun') ?? tag.text('autorun');
    if (autorunText === 'false') info.autorun = false;
    const givens = readGivens(tag);
    if (givens) info.givens = givens;
    return info;
  }

  const info: ArtifactInfo = { name, query: ident.runExpr, title };
  if (ident.source) info.source = ident.source;
  if (ident.view) info.view = ident.view;
  if (description) info.description = description;
  // `autorun=false` stages control changes behind an Apply button; live is the
  // default, so only carry the flag when explicitly turned off.
  const autorunText = nested?.text('autorun') ?? tag.text('autorun');
  if (autorunText === 'false') info.autorun = false;
  const givens = readGivens(tag);
  if (givens) info.givens = givens;
  return info;
}

/** Structural subset of a source's view field. */
type QueryFieldLike = Tagged & { name: string };
type FieldLike = { name: string; isQueryField(): boolean };
/** A source is itself Tagged — it can carry a `# artifact { tiles }` composite. */
type ExploreLike = Tagged & { name: string; allFields: FieldLike[] };
type ModelLike = Tagged & {
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
    // Model-level `## artifact { tiles }` — the cross-source composite. Only the
    // ENTRY file's model annotations are visible here (they don't cross imports),
    // and the merged tag parser exposes at most one, so this yields the single
    // cross-source dashboard declared in index.malloy. Ignored unless composite
    // (a bare `## artifact` with no tiles isn't a dashboard).
    const modelComposite = readArtifactTag({ runExpr: '', defaultName: 'dashboard' }, model);
    if (modelComposite?.tiles) artifacts.push(modelComposite);
    // Top-level `query: … # artifact` declarations.
    for (const queryName of model.queries().named) {
      const pq = model.getPreparedQueryByName(queryName) as unknown as Tagged;
      const info = readArtifactTag({ runExpr: queryName, defaultName: queryName }, pq);
      if (info) artifacts.push(info);
    }
    for (const src of model.explores) {
      // A `# artifact { tiles }` on the SOURCE itself — a composite of that
      // source's own views. Travels with the (exported) source across imports.
      const srcComposite = readArtifactTag(
        { runExpr: '', defaultName: src.name, source: src.name },
        src,
      );
      if (srcComposite?.tiles) artifacts.push(srcComposite);
      // `view: … # artifact` declarations inside each source. The run-expression
      // is `<source> -> <view>`, which `run:` accepts just like a query name.
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

/** Structure v2: read the single dashboard declared by a `dashboards/<name>.malloy`
    file — its model-level `## artifact`, which (because the file is compiled AS
    the entry) is read directly with no import-crossing or one-per-file caveat.
    `defaultName` (the file's basename) names the dashboard when the tag omits
    `name=`. Returns {ok:true, artifact: undefined} when the file has no
    `## artifact` (or a bare one with no `tiles`). Never throws on user input. */
export async function modelArtifact(
  runtime: Runtime,
  entry: URL,
  defaultName: string,
): Promise<{ ok: true; artifact?: ArtifactInfo } | { ok: false; error: string }> {
  try {
    const model = (await runtime.loadModel(entry).getModel()) as unknown as ModelLike;
    // 1. Model-level `## artifact { tiles }` — the multi-tile / cross-source form
    //    (references tiles defined elsewhere).
    const composite = readArtifactTag({ runExpr: '', defaultName }, model);
    if (composite?.tiles) return { ok: true, artifact: composite };
    // 2 & 3. A single tagged declaration IS the (single-tile) dashboard, defined
    //    inline in this file — either a top-level `query: … # artifact`, or a
    //    `view: … # artifact` inside a source the file defines/extends. Either
    //    becomes tiles=[<run-expression>]; single-tile passthrough keeps the
    //    declaration's own render tags (`# dashboard {columns=…}`, …) at the root.
    for (const queryName of model.queries().named) {
      const pq = model.getPreparedQueryByName(queryName) as unknown as Tagged;
      const info = readArtifactTag({ runExpr: queryName, defaultName }, pq);
      if (info && !info.tiles) return { ok: true, artifact: { ...info, tiles: [info.query], query: '' } };
    }
    for (const src of model.explores) {
      for (const field of src.allFields) {
        if (!field.isQueryField()) continue;
        const view = field as unknown as QueryFieldLike;
        const info = readArtifactTag(
          { runExpr: `${src.name} -> ${view.name}`, defaultName, source: src.name, view: view.name },
          view,
        );
        if (info && !info.tiles) return { ok: true, artifact: { ...info, tiles: [info.query], query: '' } };
      }
    }
    return { ok: true, artifact: undefined };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
