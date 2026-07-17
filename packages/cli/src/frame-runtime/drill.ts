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
