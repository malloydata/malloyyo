// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Composite dashboards: combine N separately-run tile results into ONE
// `# dashboard` result the Malloy renderer lays out as a grid of cards.
//
// The whole trick (verified against real results — see docs/composite-
// dashboards.md §4): in the interfaces format a `nest:` and a standalone tile
// result are STRUCTURALLY IDENTICAL. A nest is an `array<record>` column whose
// cell is an `array_cell` of `record_cell`s; a tile's `data` is that same
// `array_cell`, and its `schema.fields` are that same record shape. So each tile
// drops into a dashboard slot verbatim — no reshaping, no re-compile:
//   - tile.schema.fields  →  the nest field's element_type.record_type.fields
//   - tile.data           →  the nest field's cell (in the single dashboard row)
// and the whole thing is one `# dashboard { columns=N }`-annotated result.
//
// Structural types only — the engine does not depend on @malloydata/malloy-
// interfaces (same convention as quoting.ts / artifacts.ts). We touch just the
// slice of the Result shape we build.

/** One annotation line, e.g. `{ value: "# line_chart\n" }`. */
export interface ResultAnnotation {
  value: string;
}

/** A member of a record type (a column's shape). `type` is opaque to us — we
    copy it through verbatim. */
export interface RecordField {
  name: string;
  type: unknown;
  annotations?: ResultAnnotation[];
}

/** A schema field of a result (all result fields arrive as `kind:"dimension"`;
    measures are flattened with a `#(malloy) … calculation` annotation). */
export interface ResultField {
  kind: string;
  name: string;
  type: unknown;
  annotations?: ResultAnnotation[];
}

/** A result cell — we only ever read/copy `array_cell`/`record_cell` wrappers. */
export interface ResultCell {
  kind: string;
  array_value?: ResultCell[];
  record_value?: ResultCell[];
  [k: string]: unknown;
}

/** The slice of an interfaces-format Malloy result the combiner reads/writes. */
export interface CombinableResult {
  connection_name?: string;
  annotations?: ResultAnnotation[];
  model_annotations?: ResultAnnotation[];
  schema: { fields: ResultField[] };
  data?: ResultCell;
  [k: string]: unknown;
}

/** One tile to place in the dashboard: a display name (becomes the card's field
    name — must be unique across tiles) and the tile's own wrapped result. */
export interface DashboardTile {
  name: string;
  result: CombinableResult;
}

export interface CombineOptions {
  /** Pass-through to the dashboard nest's `columns`; omitted → renderer default. */
  columns?: number;
}

/** Render tags to lift from a tile's result-level annotations onto its card
    (its nest field): the `# …` render directives (`# line_chart`, `# shape_map`,
    `# colspan=3`, `# break`, …), but NOT the internal `#(malloy) …` metadata,
    NOT the `#" …` doc comments, and NOT a `# artifact` tag (a tile that is
    itself a single-artifact view must not drag its artifact tag into the card). */
function liftRenderTags(annotations?: ResultAnnotation[]): ResultAnnotation[] {
  if (!annotations) return [];
  return annotations.filter((a) => {
    const v = a.value;
    return v.startsWith('# ') && !v.startsWith('# artifact');
  });
}

/** Turn a tile result into a nest field: an `array<record<tile columns>>`
    dimension carrying the tile's card render tags. */
function tileAsNestField(name: string, res: CombinableResult): ResultField {
  const fields: RecordField[] = (res.schema?.fields ?? []).map((f) => ({
    name: f.name,
    type: f.type,
    annotations: f.annotations,
  }));
  return {
    kind: 'dimension',
    name,
    type: {
      kind: 'array_type',
      element_type: { kind: 'record_type', fields },
    },
    annotations: liftRenderTags(res.annotations),
  };
}

/** Ensure card names are unique (two tiles could resolve to the same view
    name); a collision gets a `_2`, `_3`, … suffix, deterministically. */
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

/**
 * Combine tiles into one `# dashboard`-annotated result. Pure — no IO, no
 * re-compile. `tiles` must already be successfully-run results; a failed tile is
 * the caller's concern (it renders an error card outside this merge).
 */
export function combineTiles(tiles: DashboardTile[], opts: CombineOptions = {}): CombinableResult {
  const taken = new Set<string>();
  const named = tiles.map((t) => ({ name: uniqueName(t.name, taken), result: t.result }));

  const columns =
    typeof opts.columns === 'number' && Number.isFinite(opts.columns)
      ? ` {columns=${Math.trunc(opts.columns)}}`
      : '';

  return {
    // Provenance carried from the first tile; the combined result never runs
    // SQL itself, so connection_name is cosmetic but the renderer reads it.
    connection_name: tiles[0]?.result.connection_name ?? 'composite',
    model_annotations: tiles[0]?.result.model_annotations,
    annotations: [{ value: `# dashboard${columns}\n` }],
    schema: { fields: named.map((t) => tileAsNestField(t.name, t.result)) },
    // One dashboard row whose columns are the tiles' data cells (verbatim).
    data: {
      kind: 'array_cell',
      array_value: [
        { kind: 'record_cell', record_value: named.map((t) => t.result.data as ResultCell) },
      ],
    },
  };
}
