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
// THE FIX is type-driven, not a guess about what a string "looks like".
// `result.data.toObject()` walks the SAME tree with the SAME normalizers as
// toJSON() and differs in exactly two ways: bigints stay real `bigint`s, and
// dates stay `Date`s. So we take toObject() and re-do those two conversions
// ourselves — narrowing a bigint to a number when it round-trips exactly, and
// ISO-stringifying dates so the output is byte-identical to today's toJSON()
// everywhere except the bigints we deliberately fixed.
//
// Reading toObject() rather than post-processing toJSON()'s strings also keeps
// us independent of upstream: if Malloy later narrows bigints itself, this
// helper is unaffected — it never looks at toJSON(). And it can never corrupt a
// genuine string column whose value happens to be "42", because it only ever
// converts values the schema already says are numbers.
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

import type { Result } from '@malloydata/malloy';

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
