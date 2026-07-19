// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Combine N separately-run tile results into ONE `# dashboard` result that the
// Malloy renderer lays out as a grid of cards — the same structural trick the
// engine once did server-side, but run client-side so the composite renderer can
// combine whatever tiles have arrived (Malloy owns the layout).
//
// The trick (interfaces format): a `nest:` and a standalone tile result are
// STRUCTURALLY IDENTICAL — a nest is an `array<record>` whose cell is an
// `array_cell` of `record_cell`s, which is exactly a tile's `data`/`schema`. So
// each tile drops into a dashboard card verbatim. Additionally, a tile that is a
// SINGLE ROW OF MEASURES (an aggregate view, no group-by / no dimensions) is
// merged straight into the outer dashboard as top-level KPI tiles instead of a
// named sub-card — matching how a native single-query dashboard renders top-level
// `aggregate:`. Its `# colspan` is distributed across those KPIs so they sum to
// the tile's width, and a `# break` lands on the first KPI.
//
// Structural types only (same convention as the engine): we touch just the slice
// of the interfaces Result we read/build.

interface ResultAnnotation {
  value: string;
}
interface RecordField {
  name: string;
  type: unknown;
  annotations?: ResultAnnotation[];
}
interface ResultField {
  kind: string;
  name: string;
  type: unknown;
  annotations?: ResultAnnotation[];
}
interface ResultCell {
  kind: string;
  array_value?: ResultCell[];
  record_value?: ResultCell[];
  [k: string]: unknown;
}
export interface CombinableResult {
  connection_name?: string;
  annotations?: ResultAnnotation[];
  model_annotations?: ResultAnnotation[];
  schema: { fields: ResultField[] };
  data?: ResultCell;
  [k: string]: unknown;
}
export interface DashboardTile {
  name: string;
  result: CombinableResult;
}

/** Render directives to lift from a tile's result annotations onto its card: the
    `# …` tags (`# line_chart`, `# colspan=3`, `# break`, …) but NOT `#(malloy) …`
    metadata, NOT `#" …` docs, and NOT the tile's own `# artifact` tag. */
function liftRenderTags(annotations?: ResultAnnotation[]): ResultAnnotation[] {
  if (!annotations) return [];
  return annotations.filter((a) => a.value.startsWith("# ") && !a.value.startsWith("# artifact"));
}

/** Turn a tile result into a nest field (an `array<record>` card) carrying the
    tile's render tags. */
function tileAsNestField(name: string, res: CombinableResult): ResultField {
  const fields: RecordField[] = (res.schema?.fields ?? []).map((f) => ({
    name: f.name,
    type: f.type,
    annotations: f.annotations,
  }));
  return {
    kind: "dimension",
    name,
    type: { kind: "array_type", element_type: { kind: "record_type", fields } },
    annotations: liftRenderTags(res.annotations),
  };
}

function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }
  let i = 2;
  while (taken.has(`${name}_${i}`)) i++;
  const out = `${name}_${i}`;
  taken.add(out);
  return out;
}

/** A field is a measure when its `#(malloy) …` annotation carries the
    `calculation` marker (that's what makes the renderer draw it as a big value).
    Dimensions (group_by / select columns) don't have it. */
function isMeasure(field: ResultField): boolean {
  return (field.annotations ?? []).some((a) => /(^|\s)calculation(\s|$)/.test(a.value));
}

/** A tile is an "aggregate row" when every field is a MEASURE (an aggregate view
    with no group-by / no dimensions / no nesting — which always yields a single
    row). Those merge as top-level KPI tiles rather than a card. This is decided
    from the SCHEMA alone (not the data), so a tile's slot is the same whether we
    have its schema-only result or its full result — the layout doesn't shift when
    data arrives. Requiring measures — not just any scalar — keeps a 1-row detail
    table (`select … limit 1`) rendering as a table card. */
export function isAggregateRow(res: CombinableResult): boolean {
  const fields = res.schema?.fields ?? [];
  return fields.length > 0 && fields.every(isMeasure);
}

function readNumericTag(annotations: ResultAnnotation[] | undefined, key: string): number | undefined {
  for (const a of annotations ?? []) {
    const m = new RegExp(`^#\\s*${key}\\s*=\\s*(\\d+)`).exec(a.value);
    if (m) return parseInt(m[1], 10);
  }
  return undefined;
}
function hasTag(annotations: ResultAnnotation[] | undefined, key: string): boolean {
  return (annotations ?? []).some((a) => new RegExp(`^#\\s*${key}(\\s|=|$)`).test(a.value.trim()));
}

/** Spread a merged tile's colspan across its N KPIs so they SUM to the tile's
    width (colspan=4 over 3 KPIs → [2,1,1]); the outer row keeps the author's
    intended proportions instead of every KPI defaulting to 1. */
export function distributeColspan(total: number, n: number): number[] {
  const base = Math.floor(total / n);
  const rem = total % n;
  return Array.from({ length: n }, (_, i) => Math.max(1, base + (i < rem ? 1 : 0)));
}

export interface CombineOptions {
  columns?: number;
}

/** Combine tiles into one `# dashboard`-annotated result. Pure — no IO. */
export function combineTiles(tiles: DashboardTile[], opts: CombineOptions = {}): CombinableResult {
  const taken = new Set<string>();
  const cols =
    typeof opts.columns === "number" && Number.isFinite(opts.columns)
      ? ` {columns=${Math.trunc(opts.columns)}}`
      : "";
  const fields: ResultField[] = [];
  const cells: (ResultCell | undefined)[] = [];
  for (const t of tiles) {
    const res = t.result;
    if (isAggregateRow(res)) {
      // Splice the tile's measures in as top-level fields (→ KPI tiles). Keep each
      // field's own annotations (the `#(malloy) … calculation` marker is what makes
      // it render as a big-value KPI), and re-apply the tile's colspan (distributed)
      // and `# break` (on the first KPI, so the group starts a fresh row). When the
      // tile is still schema-only (no data yet), each KPI cell is null — the slot
      // is reserved; the value fills in when the tile's real result arrives.
      const row = res.data?.array_value?.[0]?.record_value ?? [];
      const defs = res.schema.fields ?? [];
      const tileColspan = readNumericTag(res.annotations, "colspan");
      const spans = tileColspan ? distributeColspan(tileColspan, defs.length) : null;
      const tileBreak = hasTag(res.annotations, "break");
      defs.forEach((f, i) => {
        const ann = (f.annotations ?? []).filter((a) => !/^#\s*colspan/.test(a.value.trim()));
        if (spans) ann.push({ value: `# colspan=${spans[i]}\n` });
        if (tileBreak && i === 0) ann.push({ value: `# break\n` });
        fields.push({ ...f, name: uniqueName(f.name, taken), annotations: ann });
        cells.push(row[i] ?? { kind: "null_cell" });
      });
    } else {
      fields.push(tileAsNestField(uniqueName(t.name, taken), res));
      // A schema-only tile (no data yet) reserves an EMPTY card; its rows fill in
      // when the tile's real result arrives.
      cells.push((res.data as ResultCell) ?? { kind: "array_cell", array_value: [] });
    }
  }
  return {
    connection_name: tiles[0]?.result.connection_name ?? "composite",
    model_annotations: tiles[0]?.result.model_annotations,
    annotations: [{ value: `# dashboard${cols}\n` }],
    schema: { fields },
    data: {
      kind: "array_cell",
      array_value: [{ kind: "record_cell", record_value: cells as ResultCell[] }],
    },
  };
}
