// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// MIRROR of packages/mcp-engine/src/rows.ts — read that file for the full
// rationale (malloyyo#137: Malloy's toJSON() renders every `numberType:
// 'bigint'` as a decimal string regardless of magnitude, so Vega-Lite and
// friends sort "1","10","11","2").
//
// Why a copy instead of an import: this file belongs to the frame source set
// that `dashboard bundle` ships AS SOURCE inside dist/ and re-bundles on the
// user's machine, resolving imports against their model repo. It therefore
// cannot reference a workspace package. The copy is small and pinned to the
// engine's behaviour by packages/cli/test/json-rows.test.ts, which runs both
// implementations over the same result and asserts they agree.

/** Largest bigint that survives a round trip through a JS number. */
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = -MAX_SAFE;

/** Recursively JSON-ify one value out of toObject() (bigints, Dates, nests). */
function jsonValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value <= MAX_SAFE && value >= MIN_SAFE ? Number(value) : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value !== null && typeof value === "object" && value.constructor === Object) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = jsonValue(v);
    return out;
  }
  return value;
}

/**
 * The JSON-safe rows for a Malloy result — identical to
 * `result.data.toJSON()`, except BIGINT values within ±MAX_SAFE_INTEGER come
 * back as JSON numbers rather than strings. Typed loosely (`any`) because the
 * frame set is bundled without the Malloy type packages on the resolve path.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function jsonRows(result: any): Record<string, unknown>[] {
  // DDL statements carry no schema — mirror Result.toJSON()'s own guard.
  if (!result.hasSchema) return result.toJSON().queryResult.result;
  return result.data.toObject().map((row: unknown) => jsonValue(row) as Record<string, unknown>);
}
