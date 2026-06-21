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

/** Largest prefix of rows whose serialized size fits the budget. */
function fittingPrefix(rows: unknown[], maxBytes: number): number {
  let bytes = 2; // []
  for (let i = 0; i < rows.length; i++) {
    // Per-row serialized size + separator. Serializing row-by-row is O(total)
    // overall, same as serializing once, without building the giant string.
    const rowBytes = Buffer.byteLength(JSON.stringify(rows[i]) ?? 'null', 'utf8');
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
  return Buffer.byteLength(JSON.stringify(payload) ?? '', 'utf8') <= maxBytes;
}
