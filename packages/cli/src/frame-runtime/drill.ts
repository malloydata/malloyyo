// Drill — the shared reading of a `# drill { to=[…] }` dimension click.
//
// Two hosts render Malloy results and honor drills: the dashboard frame runtime
// (runtime.tsx — navigates to a sibling dashboard, or filters in place via a
// given), and the hosted app's ltool result view (src/components/MalloyResultView.tsx
// — links out to the dashboard). Both must read the same tag, pick the same
// target given, and escape the clicked value the same way, so that reading lives
// here once. What to DO with a resolved drill is each host's business.
//
// Browser-only (markDrillableCells touches the DOM), no host access.

import { filters } from "./filters";

/** A Malloy tag, as the renderer's field metadata exposes it. */
interface Tag {
  tag(name: string): Tag | undefined;
  text(name: string): string | undefined;
  textArray(name: string): string[] | undefined;
}

/** A result field, from a click payload or the renderer's metadata. */
interface Field {
  name: string;
  tag?: Tag;
  wasDimension?: () => boolean;
}

/** What the renderer hands `onClick`. */
export interface CellClickPayload {
  isHeader?: boolean;
  field?: Field;
  value?: unknown;
  event?: { clientX?: number; clientY?: number };
}

/** Enough of the renderer's viz handle to read field metadata. */
interface VizLike {
  getMetadata(): { getAllFields(): Field[] } | null | undefined;
}

/** A resolved drill: where it may go, and the filter to seed when it gets there. */
export interface Drill {
  /** `to=` destinations — dashboard slugs and/or the literal `self`. */
  dests: string[];
  /** Given to seed at the destination. */
  given: string;
  /** Exact-match filter expression for the clicked value, escaped. */
  filterExpr: string;
}

/** Slug → menu label: "category_dashboard"/"brand-explorer" → "Category dashboard". */
export function humanizeSlug(s: string): string {
  const t = String(s).replace(/[-_]+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Read a cell click as a drill, or null when the cell doesn't drill (a header, a
 * measure, an untagged dimension, an empty value).
 */
export function resolveDrill(payload: CellClickPayload | null | undefined): Drill | null {
  if (!payload || payload.isHeader) return null;
  const f = payload.field;
  // Only dimensions drill — a measure/aggregate click shouldn't navigate.
  if (!f || typeof f.wasDimension !== "function" || !f.wasDimension()) return null;
  const drillTag = f.tag && f.tag.tag("drill");
  if (!drillTag) return null;
  // `to=[a, self]` (array) or `to=x` (single) — a dest is a dashboard slug or `self`.
  const one = drillTag.text("to");
  const dests = drillTag.textArray("to") ?? (one ? [one] : []);
  if (!dests.length || payload.value == null) return null;
  return {
    dests,
    // The target given defaults to the dimension name upper-cased (category →
    // CATEGORY); `given=` names it explicitly when the destination's given
    // differs. One given per drill today; a future syntax may map several from a
    // single query.
    given: drillTag.text("given") || String(f.name).toUpperCase(),
    filterExpr: filters.oneOf(String(payload.value)),
  };
}

/**
 * The views a `# drill { view=[…] }` cell offers, or [] when it declares none.
 *
 * This is the MEASURE half of the drill vocabulary, and it is a different
 * mechanism from `to=`. `to=` seeds a given on another dashboard, which works
 * because a given is a named parameter two dashboards can share. A measure
 * drill produces a set of filters rooted in ONE source's namespace — there is no
 * shared contract to seed — so it stays on that source and names a view to shape
 * the rows instead. That's why it lands in ltool rather than a dashboard.
 */
export function resolveDrillViews(payload: CellClickPayload | null | undefined): string[] {
  if (!payload || payload.isHeader) return [];
  const f = payload.field;
  const drillTag = f && f.tag && f.tag.tag("drill");
  if (!drillTag) return [];
  const one = drillTag.text("view");
  return drillTag.textArray("view") ?? (one ? [one] : []);
}

/** The source a drill query targets — `run: order_items -> …` → `order_items`. */
export function drillQuerySource(drillQuery: string): string | null {
  const m = /^\s*run:\s*(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)/.exec(drillQuery);
  return m ? m[1] : null;
}

/** The renderer joins drill expressions with ",\n" — split them back apart. */
export function splitDrillClauses(whereClause: string): string[] {
  return (whereClause || "")
    .split("\n")
    .map((l) => l.trim().replace(/,$/, "").trim())
    .filter(Boolean);
}

/** Escape a filter-expression source for embedding in `f'…'`. */
function filterLiteral(src: string): string {
  return `f'${src.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * Bind a dashboard's given VALUES into its drill clauses.
 *
 * A dashboard's `where: brand ~ $BRAND` arrives as a drill clause that still
 * names the given — but the destination (ltool) has no givens, so `$BRAND` there
 * would resolve to the model's default, not what the dashboard was showing.
 * So: substitute each set given as an `f'…'` literal, and DROP any clause whose
 * givens aren't set — an unset given is `f''`, which filters nothing, so keeping
 * it would be noise at best and a default-valued filter at worst.
 */
export function bindGivensInClauses(
  clauses: string[],
  givens: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  for (const clause of clauses) {
    const refs = clause.match(/\$[A-Za-z_][A-Za-z0-9_]*/g);
    if (!refs) {
      out.push(clause);
      continue;
    }
    let bound = clause;
    let complete = true;
    for (const ref of refs) {
      const v = givens ? givens[ref.slice(1)] : undefined;
      if (v == null || String(v) === "") {
        complete = false;
        break;
      }
      bound = bound.split(ref).join(filterLiteral(String(v)));
    }
    if (complete) out.push(bound);
  }
  return out;
}

/** Assemble `run: <src> -> [<view> +] { drill: … }`. */
export function buildDrillQuery(
  src: string,
  view: string | null,
  clauses: string[],
): string {
  const head = view ? `run: ${src} -> ${view}` : `run: ${src} ->`;
  if (!clauses.length) return view ? head : `run: ${src} -> { select: * }`;
  const body = clauses.map((c) => `    ${c}`).join(",\n");
  const drill = `{\n  drill:\n${body}\n}`;
  return view ? `${head} + ${drill}` : `${head} ${drill} + { select: * }`;
}

/**
 * Rebuild a drill query: bind the dashboard's givens into the clauses, and shape
 * the rows with a `# drill { view= }` view when the clicked field named one
 * (otherwise the renderer's raw `select: *`). `drillQuery` is read only for its
 * source name. Returns null when that can't be read, so callers can fall back.
 */
export function rebuildDrillQuery(
  drillQuery: string,
  view: string | null,
  whereClause: string,
  givens?: Record<string, unknown>,
): string | null {
  const src = drillQuerySource(drillQuery);
  if (!src) return null;
  const clauses = bindGivensInClauses(splitDrillClauses(whereClause), givens ?? {});
  return buildDrillQuery(src, view, clauses);
}

/**
 * Names of the fields that declare `# drill`, from the renderer's metadata
 * (includes any `# label` so callers can match either against the header text).
 */
export function drillFieldNames(viz: VizLike): Set<string> {
  const names = new Set<string>();
  try {
    const meta = viz.getMetadata();
    const fields = meta ? meta.getAllFields() : [];
    for (const f of fields) {
      if (f && f.tag && f.tag.tag && f.tag.tag("drill")) {
        names.add(String(f.name));
        const label = f.tag.text && f.tag.text("label");
        if (label) names.add(label);
      }
    }
  } catch {
    /* metadata unavailable — no affordance, clicks still work */
  }
  return names;
}

// The renderer gives no per-cell field id, but each cell carries an inline
// `grid-column: N / …` and each table's header cells (.th) hold the field names.
const gridColStart = (el: HTMLElement): string | null => {
  const m = (el.style && el.style.gridColumn ? el.style.gridColumn : "").match(/^\s*(\d+)/);
  return m ? m[1] : null;
};

/**
 * Tag drillable cells with `dash-drill` so the host can style them as links and
 * users can see they're clickable. Per table: header .th cells at a drillable
 * field → that column's grid-column → mark this table's own body .td cells in
 * that column.
 */
export function markDrillableCells(container: HTMLElement, names: Set<string>): void {
  if (!names.size) return;
  for (const table of container.querySelectorAll<HTMLElement>(".malloy-table")) {
    const mine = (el: Element) => el.closest(".malloy-table") === table; // skip nested tables
    const cols = new Set<string>();
    for (const th of table.querySelectorAll<HTMLElement>(".column-cell.th")) {
      if (!mine(th)) continue;
      const text = (th.textContent || "").replace(/​/g, "").trim();
      const gc = gridColStart(th);
      if (gc && names.has(text)) cols.add(gc);
    }
    if (!cols.size) continue;
    for (const td of table.querySelectorAll<HTMLElement>(".column-cell.td")) {
      // Only leaf value cells — never a cell that wraps a nested table.
      const gc = gridColStart(td);
      if (mine(td) && gc && cols.has(gc) && !td.querySelector(".malloy-table")) {
        td.classList.add("dash-drill");
      }
    }
  }
}
