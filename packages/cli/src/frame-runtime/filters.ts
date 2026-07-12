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
  TemporalFilterExpression,
  type NumberFilter,
  type StringFilter,
  type TemporalFilter,
  type TemporalUnit,
} from "@malloydata/malloy-filter";

export type { TemporalUnit };

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
  /** Rolling window ending now, for a filter<timestamp|date> given:
      lastN(7, "day") → '7 days' (Malloy's "in the last 7 days"). */
  lastN(n: number, units: TemporalUnit): string;
  /** Inclusive literal date/time range: dateRange("2026-01-01", "2026-07-01")
      → '2026-01-01 to 2026-07-01'. Accepts date ('2026-01-01') or timestamp
      ('2026-01-01 12:30') literals. */
  dateRange(from: string, to: string): string;
  /** One-sided literal bounds: afterDate("2026-01-01") → 'after 2026-01-01'. */
  afterDate(literal: string): string;
  beforeDate(literal: string): string;

  // ── read (filter expression source → JS state, null when it isn't that shape) ──
  /** The exact-match values of a string filter: values('CA, NY') → ["CA","NY"].
      Null when the expression is not a plain equality list. */
  values(src: string): string[] | null;
  /** The inclusive bounds of a numeric range: numberRange('[1910 to 1930]') →
      {lo: 1910, hi: 1930}. Null when the expression is not a range. */
  numberRange(src: string): { lo: number; hi: number } | null;
  /** The bound of a one-sided comparison: threshold('> 200') → {op: ">", n: 200}. */
  threshold(src: string): { op: ">" | ">=" | "<" | "<=" | "=" | "!="; n: number } | null;
  /** The rolling window of a temporal filter: inLast('7 days') →
      {n: 7, units: "day"}. Null when the expression is not that shape. */
  inLast(src: string): { n: number; units: TemporalUnit } | null;
  /** The literal bounds of a temporal range: temporalRange('2026-01-01 to
      2026-07-01') → {from: "2026-01-01", to: "2026-07-01"}. Null otherwise. */
  temporalRange(src: string): { from: string; to: string } | null;

  // ── validate ──────────────────────────────────────────────────────
  /** True when src parses as a filter over the Malloy type
      ("string" | "number" | "timestamp" | "timestamptz" | "date"). */
  isValid(filterType: string, src: string): boolean;
}

const str = (f: StringFilter | null) => StringFilterExpression.unparse(f);
const num = (f: NumberFilter | null) => NumberFilterExpression.unparse(f);
const tmp = (f: TemporalFilter | null) => TemporalFilterExpression.unparse(f);
const isTemporalType = (t: string) => t === "timestamp" || t === "timestamptz" || t === "date";

// Exact-match filter source, minimally escaped. `unparse` conservatively
// backslash-escapes spaces/hyphens/etc. ('Outerwear\ &\ Coats', 'Ray\-Ban')
// even though those parse fine unescaped — the escaping then leaks into the URL
// and the Search box as stray `\`. So prefer the CLEAN comma-joined form when it
// round-trips to exactly these values, and only fall back to escaping when a
// value carries filter-significant punctuation (an internal comma, a leading
// '-', a '%', …) that would otherwise change the parse.
function exactMatch(values: string[]): string {
  const clean = values.join(", ");
  const { parsed, log } = StringFilterExpression.parse(clean);
  const roundTrips =
    !!parsed &&
    parsed.operator === "=" &&
    !("not" in parsed && (parsed as { not?: boolean }).not) &&
    Array.isArray((parsed as { values?: string[] }).values) &&
    (parsed as { values: string[] }).values.length === values.length &&
    (parsed as { values: string[] }).values.every((v, i) => v === values[i]) &&
    !(log || []).some((l) => l.severity === "error");
  return roundTrips ? clean : str({ operator: "=", values });
}

export const filters: FilterHelpers = {
  oneOf: (...values) => exactMatch(values),
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
  lastN: (n, units) => tmp({ operator: "in_last", units, n: String(n) }),
  dateRange: (from, to) =>
    tmp({
      operator: "to",
      fromMoment: { moment: "literal", literal: from },
      toMoment: { moment: "literal", literal: to },
    }),
  afterDate: (literal) => tmp({ operator: "after", after: { moment: "literal", literal } }),
  beforeDate: (literal) => tmp({ operator: "before", before: { moment: "literal", literal } }),

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
  inLast(src) {
    const { parsed } = TemporalFilterExpression.parse(src);
    if (parsed && parsed.operator === "in_last") {
      const n = Number(parsed.n);
      if (Number.isFinite(n)) return { n, units: parsed.units };
    }
    return null;
  },
  temporalRange(src) {
    const { parsed } = TemporalFilterExpression.parse(src);
    if (
      parsed &&
      parsed.operator === "to" &&
      parsed.fromMoment.moment === "literal" &&
      parsed.toMoment.moment === "literal"
    ) {
      return { from: parsed.fromMoment.literal, to: parsed.toMoment.literal };
    }
    return null;
  },
  isValid(filterType, src) {
    if (filterType === "number") {
      const r = NumberFilterExpression.parse(src);
      return r.parsed !== null && !r.log.some((l) => l.severity === "error");
    }
    if (isTemporalType(filterType)) {
      const r = TemporalFilterExpression.parse(src);
      return r.parsed !== null && !r.log.some((l) => l.severity === "error");
    }
    const r = StringFilterExpression.parse(src);
    return r.parsed !== null && !r.log.some((l) => l.severity === "error");
  },
};
