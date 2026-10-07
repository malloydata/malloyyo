// The explorer's query emitter: typed builder state → Malloy text.
//
// This is deliberately a SMALL, DUMB translator. It knows how to spell the
// statements an explorer composes (group_by / aggregate / where / having /
// nest / order_by / limit, a starting view, a render tag) and nothing about
// whether the result is legal — the compiler is ground truth: every Run
// compiles the text under restricted mode and the problems come back onto the
// builder. That is the whole point of replacing a DOM-like query model with a
// text emitter: no second implementation of the language.
//
// Filters are emitted ONLY as `path ~ f'…'` — never as partials
// (`x ? 'a' | 'b'`), which the language's designer wants deprecated.
//
// Pure, no browser imports, so explore-emit.test.ts can drive it directly.

export type Truncation = "year" | "quarter" | "month" | "week" | "day" | "hour" | "minute" | "second";
export type AggFn = "sum" | "avg" | "min" | "max" | "count";
export type SortDir = "asc" | "desc";

/** A field reference: the path segments from the stage's source (`["st",
    "region"]` for `st.region`), with the segments that must be backticked. */
export interface FieldRef {
  path: string[];
  /** Parallel to `path`: true where the segment needs backticks. */
  quote?: boolean[];
}

export interface GroupBy {
  id: string;
  field: FieldRef;
  /** For date/timestamp dimensions: `field.month` etc. */
  truncation?: Truncation;
  /** Output name override (`as is field`). */
  as?: string;
}

export type Aggregate =
  | { id: string; kind: "measure"; field: FieldRef; as?: string }
  | { id: string; kind: "agg"; field: FieldRef; fn: AggFn; as?: string }
  | { id: string; kind: "count"; as?: string };

export interface Filter {
  id: string;
  field: FieldRef;
  /** The field's Malloy type — decides which filter sub-language applies. */
  type: string;
  /** The filter-expression source text (what goes inside `f'…'`). */
  text: string;
  /** True when `field` is a measure: emitted as `having:` instead of `where:`. */
  measure?: boolean;
}

export interface Nest {
  id: string;
  name: string;
  stage: Stage;
}

export interface OrderBy {
  id: string;
  /** An OUTPUT name of this stage (what order_by: accepts). */
  name: string;
  dir?: SortDir;
}

export interface Stage {
  /** Start from a named view of the source: `source -> view + { … }`. */
  view?: string;
  groupBy: GroupBy[];
  aggregates: Aggregate[];
  filters: Filter[];
  nests: Nest[];
  orderBy: OrderBy[];
  limit?: number;
  /** A renderer tag name (`bar_chart`, `line_chart`, …) or undefined for the
      default table. */
  viz?: string;
}

export interface ExplorerState {
  source: string;
  sourceQuoted?: boolean;
  stage: Stage;
}

export const emptyStage = (): Stage => ({
  groupBy: [],
  aggregates: [],
  filters: [],
  nests: [],
  orderBy: [],
});

export const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Backtick a segment when it isn't a plain identifier, or when the schema
    says it must be (a reserved word is a plain identifier the compiler still
    refuses bare). */
export function quoteSeg(seg: string, mustQuote?: boolean): string {
  return mustQuote || !IDENT_RE.test(seg) ? `\`${seg.replace(/`/g, "")}\`` : seg;
}

export function refText(ref: FieldRef): string {
  return ref.path.map((seg, i) => quoteSeg(seg, ref.quote?.[i])).join(".");
}

/** The name a bare reference gets in a stage's output: its last segment. */
export const refLeaf = (ref: FieldRef): string => ref.path[ref.path.length - 1] ?? "";

/** Escape text for the inside of `f'…'`: the filter body is raw, `\` escapes
    the next character, so a quote and a backslash each need a backslash. */
export function filterLiteral(text: string): string {
  // A bare given reference (`$STATE`) is applied as itself — the model's
  // filter<T> given — not quoted into a literal.
  if (GIVEN_REF_RE.test(text.trim())) return text.trim();
  return `f'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export const GIVEN_REF_RE = /^\$[A-Za-z_][A-Za-z0-9_]*$/;

/** A legal output name from a suggestion: non-identifier characters become
    `_`, and a leading digit gets one too. */
export function safeName(s: string): string {
  const n = s.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[0-9]/.test(n) ? `_${n}` : n || "field";
}

/** The output name of each field statement in a stage, in order, with the
    automatic disambiguation the emitter applies: a bare reference whose leaf
    collides with an earlier output name is spelled `a_b` from its path. The
    builder shows these names (order_by: works in output names) and the emitter
    uses the same function, so the two can't disagree. */
export function outputNames(stage: Stage): { groupBy: string[]; aggregates: string[]; nests: string[] } {
  const used = new Set<string>();
  const take = (want: string): string => {
    let name = want;
    let n = 2;
    while (used.has(name)) name = `${want}_${n++}`;
    used.add(name);
    return name;
  };
  const groupBy = stage.groupBy.map((g) => {
    if (g.as) return take(safeName(g.as));
    const leaf = refLeaf(g.field);
    // `ordered_on.month` is output as `ordered_on` (Malloy names it by the field).
    if (!used.has(leaf)) return take(leaf);
    return take(safeName(g.field.path.join("_")));
  });
  const aggregates = stage.aggregates.map((a) => {
    if (a.as) return take(safeName(a.as));
    if (a.kind === "measure") {
      const leaf = refLeaf(a.field);
      if (!used.has(leaf)) return take(leaf);
      return take(safeName(a.field.path.join("_")));
    }
    if (a.kind === "count") return take("row_count");
    return take(safeName(`${a.field.path.join("_")}_${a.fn}`));
  });
  const nests = stage.nests.map((n) => take(safeName(n.name)));
  return { groupBy, aggregates, nests };
}

const INDENT = "  ";

function emitStageBody(stage: Stage, depth: number): string[] {
  const pad = INDENT.repeat(depth);
  const lines: string[] = [];
  const names = outputNames(stage);

  const where = stage.filters.filter((f) => !f.measure && f.text.trim() !== "");
  if (where.length) {
    lines.push(`${pad}where:`);
    where.forEach((f, i) => {
      lines.push(`${pad}${INDENT}${refText(f.field)} ~ ${filterLiteral(f.text)}${i < where.length - 1 ? "," : ""}`);
    });
  }

  if (stage.groupBy.length) {
    lines.push(`${pad}group_by:`);
    stage.groupBy.forEach((g, i) => {
      const ref = refText(g.field) + (g.truncation ? `.${g.truncation}` : "");
      const name = names.groupBy[i];
      // A plain reference is output under its leaf (or leaf.truncation → leaf);
      // anything else needs `name is`.
      const bare = !g.as && name === refLeaf(g.field);
      lines.push(`${pad}${INDENT}${bare ? ref : `${name} is ${ref}`}`);
    });
  }

  if (stage.aggregates.length) {
    lines.push(`${pad}aggregate:`);
    stage.aggregates.forEach((a, i) => {
      const name = names.aggregates[i];
      if (a.kind === "measure") {
        const bare = !a.as && name === refLeaf(a.field);
        lines.push(`${pad}${INDENT}${bare ? refText(a.field) : `${name} is ${refText(a.field)}`}`);
      } else if (a.kind === "count") {
        lines.push(`${pad}${INDENT}${name} is count()`);
      } else {
        // Aggregate locality: `path.field.fn()` computes at the field's own
        // source, which is the correct answer across any join fan-out.
        lines.push(`${pad}${INDENT}${name} is ${refText(a.field)}.${a.fn}()`);
      }
    });
  }

  stage.nests.forEach((n, i) => {
    // An empty nest (no view, nothing requested) is not a query yet: leave it
    // out rather than emit `nest: x is { }`, which the compiler rejects.
    if (!n.stage.view && n.stage.groupBy.length === 0 && n.stage.aggregates.length === 0) return;
    const name = names.nests[i];
    if (n.stage.viz) lines.push(`${pad}# ${n.stage.viz}`);
    const inner = n.stage.view
      ? `${quoteSeg(n.stage.view)}${hasBody(n.stage) ? " + {" : ""}`
      : "{";
    if (!n.stage.view || hasBody(n.stage)) {
      lines.push(`${pad}nest: ${quoteSeg(name)} is ${inner}`);
      lines.push(...emitStageBody(n.stage, depth + 1));
      lines.push(`${pad}}`);
    } else {
      lines.push(`${pad}nest: ${quoteSeg(name)} is ${inner}`);
    }
  });

  const having = stage.filters.filter((f) => f.measure && f.text.trim() !== "");
  if (having.length) {
    lines.push(`${pad}having:`);
    having.forEach((f, i) => {
      lines.push(`${pad}${INDENT}${refText(f.field)} ~ ${filterLiteral(f.text)}${i < having.length - 1 ? "," : ""}`);
    });
  }

  // order_by: names must be OUTPUT names. Without a starting view the outputs
  // are exactly what this stage requests, so a name that is no longer among
  // them (its field was removed or renamed) is dropped rather than emitted as
  // a compile error. With a view, the view's own outputs are also legal and
  // unknown here, so every name passes through to the compiler.
  const known = new Set([...names.groupBy, ...names.aggregates, ...names.nests]);
  const orderBy = stage.view ? stage.orderBy : stage.orderBy.filter((o) => known.has(o.name));
  if (orderBy.length) {
    const parts = orderBy.map((o) => `${quoteSeg(o.name)}${o.dir ? ` ${o.dir}` : ""}`);
    lines.push(`${pad}order_by: ${parts.join(", ")}`);
  }
  if (typeof stage.limit === "number" && Number.isFinite(stage.limit) && stage.limit > 0) {
    lines.push(`${pad}limit: ${Math.floor(stage.limit)}`);
  }
  return lines;
}

/** Whether a stage adds anything beyond its starting view. */
export function hasBody(stage: Stage): boolean {
  return (
    stage.groupBy.length > 0 ||
    stage.aggregates.length > 0 ||
    stage.filters.some((f) => f.text.trim() !== "") ||
    stage.nests.length > 0 ||
    stage.orderBy.length > 0 ||
    (typeof stage.limit === "number" && stage.limit > 0)
  );
}

/** Is there anything to run? A view alone is runnable; an empty stage is not. */
export function isRunnable(state: ExplorerState): boolean {
  const s = state.stage;
  return !!s.view || s.groupBy.length > 0 || s.aggregates.length > 0;
}

/** The whole query, as `run:` text the restricted runner accepts. */
export function emitMalloy(state: ExplorerState): string {
  const s = state.stage;
  const src = quoteSeg(state.source, state.sourceQuoted);
  const lines: string[] = [];
  if (s.viz) lines.push(`# ${s.viz}`);
  if (s.view && !hasBody(s)) {
    lines.push(`run: ${src} -> ${quoteSeg(s.view)}`);
    return lines.join("\n");
  }
  lines.push(`run: ${src} -> ${s.view ? `${quoteSeg(s.view)} + ` : ""}{`);
  lines.push(...emitStageBody(s, 1));
  lines.push("}");
  return lines.join("\n");
}
