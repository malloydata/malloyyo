// JS helpers for Malloy filter expressions — the values dashboards bind to
// `filter<T>` givens. Controls hold ordinary JS state (a list of picks, a
// lo/hi pair); these helpers convert to/from filter-expression SOURCE strings
// with correct escaping, backed by Malloy's own parser (@malloydata/malloy-filter)
// so a dashboard never string-concatenates a filter by hand.
//
// Bundled into the sandboxed frame and handed to Dashboard.tsx as the
// `filters` prop. Pure functions, no host access.

import {
  NumberFilterExpression,
  StringFilterExpression,
  type NumberFilter,
  type StringFilter,
} from "@malloydata/malloy-filter";

export interface FilterHelpers {
  // ── build (JS state → filter expression source) ──────────────────
  /** Exact-match alternatives: oneOf("CA","NY") → 'CA, NY' (escaped). */
  oneOf(...values: string[]): string;
  /** Substring / prefix / suffix match: contains("ann") → '%ann%'. */
  contains(s: string): string;
  startsWith(s: string): string;
  endsWith(s: string): string;
  /** Inclusive numeric range: between(1910, 1930) → '[1910 to 1930]'. */
  between(lo: number, hi: number): string;
  greaterThan(n: number): string;
  atLeast(n: number): string;
  lessThan(n: number): string;
  atMost(n: number): string;

  // ── read (filter expression source → JS state, null when it isn't that shape) ──
  /** The exact-match values of a string filter: values('CA, NY') → ["CA","NY"].
      Null when the expression is not a plain equality list. */
  values(src: string): string[] | null;
  /** The inclusive bounds of a numeric range: numberRange('[1910 to 1930]') →
      {lo: 1910, hi: 1930}. Null when the expression is not a range. */
  numberRange(src: string): { lo: number; hi: number } | null;
  /** The bound of a one-sided comparison: threshold('> 200') → {op: ">", n: 200}. */
  threshold(src: string): { op: ">" | ">=" | "<" | "<=" | "=" | "!="; n: number } | null;

  // ── validate ──────────────────────────────────────────────────────
  /** True when src parses as a filter over the Malloy type ("string" | "number"). */
  isValid(filterType: string, src: string): boolean;
}

const str = (f: StringFilter | null) => StringFilterExpression.unparse(f);
const num = (f: NumberFilter | null) => NumberFilterExpression.unparse(f);

export const filters: FilterHelpers = {
  oneOf: (...values) => str({ operator: "=", values }),
  contains: (s) => str({ operator: "contains", values: [s] }),
  startsWith: (s) => str({ operator: "starts", values: [s] }),
  endsWith: (s) => str({ operator: "ends", values: [s] }),
  between: (lo, hi) =>
    num({
      operator: "range",
      startOperator: ">=",
      startValue: String(lo),
      endOperator: "<=",
      endValue: String(hi),
    }),
  greaterThan: (n) => num({ operator: ">", values: [String(n)] }),
  atLeast: (n) => num({ operator: ">=", values: [String(n)] }),
  lessThan: (n) => num({ operator: "<", values: [String(n)] }),
  atMost: (n) => num({ operator: "<=", values: [String(n)] }),

  values(src) {
    const { parsed } = StringFilterExpression.parse(src);
    if (parsed && parsed.operator === "=" && !("not" in parsed && parsed.not)) {
      return (parsed as { values: string[] }).values;
    }
    return null;
  },
  numberRange(src) {
    const { parsed } = NumberFilterExpression.parse(src);
    if (parsed && parsed.operator === "range") {
      const r = parsed as { startValue: string; endValue: string };
      const lo = Number(r.startValue);
      const hi = Number(r.endValue);
      if (Number.isFinite(lo) && Number.isFinite(hi)) return { lo, hi };
    }
    return null;
  },
  threshold(src) {
    const { parsed } = NumberFilterExpression.parse(src);
    if (
      parsed &&
      (parsed.operator === ">" ||
        parsed.operator === ">=" ||
        parsed.operator === "<" ||
        parsed.operator === "<=" ||
        parsed.operator === "=" ||
        parsed.operator === "!=")
    ) {
      const v = (parsed as { values: string[] }).values;
      const n = Number(v?.[0]);
      if (Number.isFinite(n)) return { op: parsed.operator, n };
    }
    return null;
  },
  isValid(filterType, src) {
    if (filterType === "number") {
      const r = NumberFilterExpression.parse(src);
      return r.parsed !== null && !r.log.some((l) => l.severity === "error");
    }
    const r = StringFilterExpression.parse(src);
    return r.parsed !== null && !r.log.some((l) => l.severity === "error");
  },
};
