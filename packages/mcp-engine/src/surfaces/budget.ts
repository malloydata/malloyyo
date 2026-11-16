// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Context is the budget (principle 4). Row limits bound memory; this bounds
// what goes into an LLM context. Whole rows are dropped from the end (first-N
// respects the query's own ordering); the response always says what happened
// and how to get more; completeness belongs in an artifact (spill → link),
// never in paging results through the model.

import type { RunResult } from '../types';
import type { ResultPolicy, SpillContext } from './shared';
import { DEFAULT_RESULT_BYTES } from './shared';

const REFINE_HINT =
  'Aggregate, filter, or do top-N in Malloy rather than fetching rows to ' +
  'post-process; select fewer columns if rows are wide.';

/**
 * UTF-8 byte length of a string, without Node's Buffer: the core runs outside
 * Node (the malloy-duckdb extension runs it in QuickJS). A surrogate pair is
 * one 4-byte character; a lone surrogate encodes as U+FFFD, 3 bytes, as
 * Buffer counts it.
 */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next < 0xe000) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** Largest prefix of rows whose serialized size fits the budget. */
function fittingPrefix(rows: unknown[], maxBytes: number): number {
  let bytes = 2; // []
  for (let i = 0; i < rows.length; i++) {
    // Per-row serialized size + separator. Serializing row-by-row is O(total)
    // overall, same as serializing once, without building the giant string.
    const rowBytes = utf8Length(JSON.stringify(rows[i]) ?? 'null');
    if (bytes + rowBytes + 1 > maxBytes) return i;
    bytes += rowBytes + 1;
  }
  return rows.length;
}

/**
 * Apply the byte budget (and the spill hook) to a successful run result.
 * `stable_result` never travels through here untouched — it is stripped
 * before the wire regardless (host renderers read it from the full result).
 */
export async function applyResultBudget(
  full: RunResult,
  policy: ResultPolicy | undefined,
  ctx: SpillContext,
): Promise<RunResult> {
  const { stable_result, ...wire } = full;
  void stable_result;
  if (!wire.ok || !wire.rows) return wire;

  const maxBytes = policy?.maxResultBytes ?? DEFAULT_RESULT_BYTES;
  const keep = fittingPrefix(wire.rows, maxBytes);
  if (keep >= wire.rows.length) return wire; // fits — row_limit truncation (if any) stands

  let fullResultUri: string | undefined;
  if (policy?.spill) {
    try {
      fullResultUri = (await policy.spill(full, ctx))?.uri;
    } catch {
      // Spill is best-effort decoration; a failing spill must not fail the run.
    }
  }

  const out: RunResult = {
    ...wire,
    rows: wire.rows.slice(0, keep),
    rows_returned: keep,
    truncated: {
      reason: 'byte_budget',
      hint:
        keep === 0
          ? 'A single row exceeds the response byte budget — project fewer ' +
            'columns or un-nest the result. ' + REFINE_HINT
          : `Result truncated to ${keep} of ${wire.row_count} rows to fit the ` +
            'response byte budget. ' + REFINE_HINT,
      ...(fullResultUri ? { full_result: fullResultUri } : {}),
    },
  };
  return out;
}

/** Serialized size check for describe payloads (the index/full decision). */
export function fitsDescribeBudget(
  payload: unknown,
  policy: ResultPolicy | undefined,
): boolean {
  const maxBytes =
    policy?.maxDescribeBytes ?? policy?.maxResultBytes ?? DEFAULT_RESULT_BYTES;
  return utf8Length(JSON.stringify(payload) ?? '') <= maxBytes;
}
