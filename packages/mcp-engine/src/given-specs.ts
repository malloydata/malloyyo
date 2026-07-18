// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Dashboard given specs: the control contract a dashboard runtime needs, read
// from the MODEL's `given:` declarations — the single source of truth. A spec
// carries the declared type (filter<T> preferred), the literal default, the
// doc comment, and the parsed `# key=value` tag properties (the dashboard
// vocabulary: label, control, suggest, …). Shared by the CLI dev server and the
// hosted serving path so the two can't drift.

import type { Runtime } from '@malloydata/malloy';

export interface DashboardGivenSpec {
  name: string;
  /** Rendered Malloy type: "filter<string>", "number", "string", … */
  type: string;
  /** For `filter<T>` givens, the T ("string" | "number" | "date" | …). */
  filterType?: string;
  /** Declaration default as a JS value. For filter givens this is the filter
      expression source (e.g. "[1910 to 1930]"). Absent = caller must supply
      (or the default is a non-literal expression, which still applies at run
      time when the caller sends nothing). */
  default?: string | number | boolean;
  /** The `#" …` doc comment on the declaration. */
  description?: string;
  /** Parsed `# key=value` tag properties on the declaration. Bare tags → true. */
  tags?: Record<string, string | number | boolean>;
  /** Structured options declaration from the given's `# suggest { … }` tag:
      {source, dimension} = distinct values of a dimension; {query[, dimension]} =
      a named query's first column (dimension enables server-side typeahead). */
  suggest?: { source?: string; dimension?: string; query?: string };
}

export type DashboardGivenSpecsResult =
  | { ok: true; givens: DashboardGivenSpec[] }
  | { ok: false; error: string };

type GivenTypeShape = {
  type: string;
  filterType?: string;
  elementTypeDef?: GivenTypeShape & { type: string };
};

/** Structural subset of malloy's `Given` foundation wrapper (not re-exported). */
type GivenLike = {
  type: GivenTypeShape;
  default: { node: string; [k: string]: unknown } | undefined;
  annotations: {
    forRoute(route?: string): Array<{ content: string }>;
    parseAsTag(route?: string): { tag: TagLike };
  };
};

type TagLike = {
  dict: Record<string, { eq?: unknown; dict?: Record<string, { eq?: unknown }> }>;
};

function renderGivenType(t: GivenTypeShape): string {
  if (t.type === 'filter expression') {
    return t.filterType ? `filter<${t.filterType}>` : 'filter';
  }
  if (t.type === 'array') {
    const elem = t.elementTypeDef;
    if (!elem) return 'array';
    if (elem.type === 'record_element') return 'record[]';
    return `${renderGivenType(elem)}[]`;
  }
  return t.type;
}

/** The declaration default as a plain JS value, when it's a literal we can
    surface to a control. */
function defaultValue(e: GivenLike['default']): string | number | boolean | undefined {
  if (!e) return undefined;
  switch (e.node) {
    case 'filterLiteral':
      return e.filterSrc as string;
    case 'stringLiteral':
      return e.literal as string;
    case 'numberLiteral':
      return Number(e.literal);
    case 'true':
      return true;
    case 'false':
      return false;
    case 'dateLiteral':
    case 'timestampLiteral':
    case 'timestamptzLiteral':
      return e.literal as string;
    default:
      return undefined;
  }
}

export function describeGivenSpec(name: string, g: GivenLike): DashboardGivenSpec {
  const spec: DashboardGivenSpec = { name, type: renderGivenType(g.type) };
  if (g.type.type === 'filter expression' && g.type.filterType) {
    spec.filterType = g.type.filterType;
  }
  const dflt = defaultValue(g.default);
  if (dflt !== undefined) spec.default = dflt;
  try {
    const docs = g.annotations
      .forRoute('"')
      .map((n) => n.content.trim())
      .filter(Boolean);
    if (docs.length) spec.description = docs.join('\n');
  } catch {
    /* docs stay absent */
  }
  try {
    const dict = g.annotations.parseAsTag().tag.dict ?? {};
    const tags: Record<string, string | number | boolean> = {};
    for (const [key, t] of Object.entries(dict)) {
      const eq = t.eq;
      if (typeof eq === 'string' || typeof eq === 'number' || typeof eq === 'boolean') {
        tags[key] = eq;
      } else if (eq === undefined && !t.dict) {
        tags[key] = true; // bare tag, e.g. `# multi` — nested tags (suggest) are structured below
      }
    }
    if (Object.keys(tags).length) spec.tags = tags;
    // `# suggest { … }` is a nested tag (no scalar eq), so the flattening
    // above skips it — pull its string properties out structurally.
    const suggestDict = dict.suggest?.dict;
    if (suggestDict) {
      const suggest: DashboardGivenSpec['suggest'] = {};
      for (const key of ['source', 'dimension', 'query'] as const) {
        const eq = suggestDict[key]?.eq;
        if (typeof eq === 'string') suggest[key] = eq;
      }
      if (suggest.source || suggest.query) spec.suggest = suggest;
    }
  } catch {
    /* tags stay absent */
  }
  return spec;
}

/**
 * The given specs a dashboard's run-expression transitively references (the
 * authoritative "what controls does this dashboard need"). `runExpr` is a
 * top-level query name or a `<source> -> <view>` path — both compile as
 * `run: <runExpr>`, whose PreparedQuery exposes exactly the givens it touches.
 * (A view's `.givens` is only populated through this compiled `run:` path, not
 * via `Explore.getQueryByName`, so we always go through `loadQuery`.)
 * Never throws on user input — unknown query / compile failure come back as
 * {ok:false}.
 */
export async function dashboardGivenSpecs(
  runtime: Runtime,
  entry: URL,
  runExpr: string,
): Promise<DashboardGivenSpecsResult> {
  try {
    const mm = runtime.loadModel(entry);
    const pq = await mm.loadQuery(`run: ${runExpr}`).getPreparedQuery();
    const specs: DashboardGivenSpec[] = [];
    for (const [name, g] of (pq as unknown as { givens: ReadonlyMap<string, unknown> }).givens) {
      specs.push(describeGivenSpec(name, g as GivenLike));
    }
    return { ok: true, givens: specs };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The grid-placement tags a composite tile carries — read from the tile's
    compiled query annotations (the SAME `# colspan` / `# break` the old combined
    `# dashboard` renderer honored). Lets the independent grid mirror the
    single-query `# dashboard {columns=N}` layout. */
export interface TileRenderTags {
  colspan?: number;
  break?: boolean;
  /** True when the tile's top-level render is a chart (`# line_chart`,
      `# bar_chart`, …). Charts have no intrinsic height (the render web component
      collapses), so the grid gives them a fixed one; KPI/table tiles size to
      their content, as the Malloy dashboard renderer does. */
  chart?: boolean;
}

type RenderTagLike = { has(key: string): boolean; numeric(key: string): number | undefined };

// Render tags whose viz needs an explicit height. `# dashboard` (KPI tiles) and
// plain tables are content-sized, so they're deliberately NOT here.
const CHART_TAGS = [
  'line_chart',
  'bar_chart',
  'column_chart',
  'scatter_chart',
  'shape_map',
  'segment_map',
  'point_map',
];

/** Introspect a composite tile in ONE compile pass: the given specs it
    references (the controls) AND its grid-placement tags (`# colspan`, `# break`).
    Never throws on user input — compile failure comes back as {ok:false}. */
export async function tileIntrospect(
  runtime: Runtime,
  entry: URL,
  runExpr: string,
): Promise<
  ({ ok: true; givens: DashboardGivenSpec[] } & TileRenderTags) | { ok: false; error: string }
> {
  try {
    const mm = runtime.loadModel(entry);
    const pq = await mm.loadQuery(`run: ${runExpr}`).getPreparedQuery();
    const givens: DashboardGivenSpec[] = [];
    for (const [name, g] of (pq as unknown as { givens: ReadonlyMap<string, unknown> }).givens) {
      givens.push(describeGivenSpec(name, g as GivenLike));
    }
    const render: TileRenderTags = {};
    try {
      const tag = (
        pq as unknown as { annotations: { parseAsTag(): { tag: RenderTagLike } } }
      ).annotations.parseAsTag().tag;
      const cs = tag.numeric('colspan');
      if (typeof cs === 'number' && Number.isFinite(cs)) render.colspan = Math.trunc(cs);
      if (tag.has('break')) render.break = true;
      if (CHART_TAGS.some((t) => tag.has(t))) render.chart = true;
    } catch {
      /* no readable tags → no placement hints */
    }
    return { ok: true, givens, ...render };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
