// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Row serialization — the one place that decides how a Malloy result becomes
// JSON on the wire.
//
// WHY THIS EXISTS. Malloy's `Result.toJSON()` renders every `numberType:
// 'bigint'` value as a decimal STRING, regardless of magnitude:
//
//   run: t -> { group_by: big }   // big is 1::BIGINT
//   toJSON() => [{"big": "1"}]
//
// The set of things typed `bigint` is wide — DuckDB BIGINT/UBIGINT/HUGEINT/
// UHUGEINT, EVERY BigQuery INT64/INTEGER, every Snowflake integer down to
// tinyint, Postgres/MySQL bigint, plus any sum() over one of those — so in
// practice most integer columns arrive as strings. Nothing downstream
// compensates, so consumers that expect numbers get lexicographic behaviour
// instead: a Vega-Lite `quantitative` channel sorts "1","10","11","2", charts
// render the wrong shape, and none of it errors. (malloyyo#137)
//
// TO BE CLEAR, toJSON()'s behaviour is DELIBERATE upstream, not a bug — JSON
// has no int64, and "bigint fields serialize as strings" is a documented Malloy
// invariant its reviewers enforce. Malloy's answer for consumers who need the
// type is the stable API, whose typed cells carry `subtype: "bigint"` next to
// both `number_value` and `string_value`. We diverge knowingly, because we ship
// plain JSON rows as a product surface (MCP `query`, /api/run, dashboard
// useQuery) where no schema travels with the values and the consumer is often
// an LLM or a chart library that will never reconstruct a Result. This is not a
// stopgap awaiting an upstream fix; expect toJSON() to keep its contract.
//
// THE FIX is type-driven, not a guess about what a string "looks like".
// `result.data.toObject()` walks the SAME tree with the SAME normalizers as
// toJSON() and differs in exactly two ways: bigints stay real `bigint`s, and
// dates stay `Date`s. So we take toObject() and re-do those two conversions
// ourselves — narrowing a bigint to a number when it round-trips exactly, and
// ISO-stringifying dates so the output is byte-identical to today's toJSON()
// everywhere except the bigints we deliberately fixed.
//
// Reading toObject() rather than post-processing toJSON()'s strings also means
// we never depend on toJSON()'s contract, so a change there cannot surprise us
// in either direction. And it can never corrupt a genuine string column whose
// value happens to be "42", because it only ever converts values the schema
// already says are numbers.
//
// THE REMAINING (deliberate) HOLE: a value beyond Number.MAX_SAFE_INTEGER stays
// a string, because JSON has no int64 and the alternative is silent precision
// loss. So the wire type is value-dependent — the same column can arrive as a
// number in one result and a string in another. Consumers that must be exact
// should read the type from `stable_result`, whose schema carries
// `subtype: "bigint"` alongside both `number_value` and `string_value`.
//
// MIRROR: packages/cli/src/shared/json-rows.ts is a standalone copy for the
// static-site browser bundle, which cannot import this package (the frame
// source set ships as source and must resolve with no workspace deps). The two
// are kept in lockstep by packages/cli/test/json-rows.test.ts.

import { tagFromAnnotations, type Result } from '@malloydata/malloy';
import type { ColumnInfo } from './types';

/** Largest bigint that survives a round trip through a JS number. */
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = -MAX_SAFE;

/** Convert one bigint to its JSON form: a number when exact, else the digits. */
function narrowBigint(value: bigint): number | string {
  return value <= MAX_SAFE && value >= MIN_SAFE ? Number(value) : value.toString();
}

/** Recursively JSON-ify one value out of toObject() (bigints, Dates, nests). */
function jsonValue(value: unknown): unknown {
  if (typeof value === 'bigint') return narrowBigint(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonValue);
  // Nested records arrive as plain objects; Buffer/Uint8Array (bytes) and any
  // other exotic cell pass through untouched, exactly as toJSON() leaves them.
  if (value !== null && typeof value === 'object' && value.constructor === Object) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = jsonValue(v);
    return out;
  }
  return value;
}

/**
 * The JSON-safe rows for a Malloy result — the wire form of `result.data`.
 *
 * Use this everywhere instead of `result.toJSON().queryResult.result` or
 * `result.data.toJSON()`: identical output, except that BIGINT values within
 * ±Number.MAX_SAFE_INTEGER come back as JSON numbers rather than strings.
 */
export function jsonRows(result: Result): Record<string, unknown>[] {
  // DDL statements (INSTALL, LOAD, CREATE SECRET…) carry no schema, so there is
  // no tree to walk — mirror Result.toJSON()'s own guard and pass them through.
  if (!result.hasSchema) {
    return result.toJSON().queryResult.result as Record<string, unknown>[];
  }
  return result.data.toObject().map((row) => jsonValue(row) as Record<string, unknown>);
}

type StableField = ReturnType<Result['toStableResult']>['schema']['fields'][number];
type StableType = Extract<StableField, { kind: 'dimension' }>['type'];
type StableAnnotations = Extract<StableField, { kind: 'dimension' }>['annotations'];

/** The tag properties that say how one value displays — the renderer's cell
    formats. */
const FORMAT_PROPS = ['currency', 'percent', 'duration', 'number'] as const;

/**
 * A field's declared display format, as the modeler wrote it (`currency=usd0k`,
 * `number="mmm yyyy"`, `percent`), or undefined when it declares none. Only
 * the format properties: a `label=` or chart tag on the same line is not a
 * format. Re-serialized from the parsed tag rather than formatted here, so
 * this can never disagree with the renderer about what the format is.
 */
function columnFormat(annotations: StableAnnotations): string | undefined {
  if (!annotations?.length) return undefined;
  const tag = tagFromAnnotations(annotations, '');
  const properties: Record<string, unknown> = {};
  for (const p of FORMAT_PROPS) if (tag.has(p)) properties[p] = tag.dict[p];
  if (Object.keys(properties).length === 0) return undefined;
  // The Tag class, reached through the instance: malloy-tag is core's
  // dependency, not this package's.
  const TagClass = tag.constructor as new (init: { properties: Record<string, unknown> }) => {
    toString(): string;
  };
  return new TagClass({ properties }).toString().replace(/^#\s*/, '').trim();
}

/**
 * The zone a nest's timestamps display in: its own `timezone:`, which the
 * result carries as `#(malloy) query_timezone=…` on the nest, else the zone it
 * inherits. The renderer's rule (getEffectiveQueryTimezone).
 */
function nestTimezone(annotations: StableAnnotations, inherited: string | undefined): string | undefined {
  if (!annotations?.length) return inherited;
  return tagFromAnnotations(annotations, 'malloy').text('query_timezone') ?? inherited;
}

function column(
  name: string,
  t: StableType,
  annotations: StableAnnotations,
  timezone: string | undefined,
): ColumnInfo {
  const format = columnFormat(annotations);
  const nested = t.kind === 'record_type' || t.kind === 'array_type';
  const info: ColumnInfo = {
    name,
    ...columnType(t, nested ? nestTimezone(annotations, timezone) : timezone),
    ...(format ? { format } : {}),
  };
  // A timestamp is an instant: say which zone its wall clock reads in. A date
  // is a calendar day and has none.
  if (timezone && (info.type === 'timestamp' || info.type === 'timestamptz')) info.timezone = timezone;
  return info;
}

function columnType(t: StableType, timezone: string | undefined): Omit<ColumnInfo, 'name'> {
  switch (t.kind) {
    case 'number_type':
      return t.subtype ? { type: 'number', subtype: t.subtype } : { type: 'number' };
    case 'date_type':
    case 'timestamp_type':
    case 'timestamptz_type': {
      const type = t.kind.replace(/_type$/, '');
      return t.timeframe ? { type, timeframe: t.timeframe } : { type };
    }
    case 'record_type':
      return { type: 'record', fields: t.fields.map((f) => column(f.name, f.type, f.annotations, timezone)) };
    case 'array_type': {
      const el = columnType(t.element_type, timezone);
      return el.type === 'record' ? { type: 'array', fields: el.fields } : { type: 'array', element: el };
    }
    default:
      return { type: t.kind.replace(/_type$/, '') };
  }
}

/**
 * The column types of a Malloy result — the schema `rows` lose on the way to
 * JSON, where a date is a string and a bigint may be either — each column's
 * declared display format, and the zone a timestamp's wall clock reads in.
 * Read from the stable schema (no data), in output order.
 */
export function resultColumns(result: Result): ColumnInfo[] | undefined {
  if (!result.hasSchema) return undefined;
  const stable = result.toStableResult();
  const out: ColumnInfo[] = [];
  for (const f of stable.schema.fields) {
    if (f.kind === 'dimension' || f.kind === 'measure' || f.kind === 'calculate') {
      out.push(column(f.name, f.type, f.annotations, stable.query_timezone));
    }
  }
  return out;
}
