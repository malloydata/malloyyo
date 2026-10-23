// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * Bound a caller-supplied row limit.
 *
 * `/api/run` and `/api/ask` take `maxRows` straight off the request body and
 * handed it to DuckDB as the row limit, unchecked. A signed-in member could
 * send `maxRows: 1e9` and have the server materialize an entire source into
 * memory on a shared instance, or send a non-number and get a `slice(0, NaN)`
 * that silently returned nothing. The MCP `query` tool already clamps its own
 * `max_rows` to [1, 10000] (packages/mcp-engine/src/surfaces/explore.ts); this
 * is the same rule for the web routes, in one place so the two cannot drift.
 *
 * Anything that is not a finite number falls back to the default rather than
 * being refused: the field is optional and a bad value is a client bug, not an
 * attack worth a 400.
 */
export const MAX_WEB_ROWS = 10_000;
export const DEFAULT_WEB_ROWS = 1_000;

export function clampRowLimit(
  input: unknown,
  dflt: number = DEFAULT_WEB_ROWS,
  max: number = MAX_WEB_ROWS,
): number {
  const n = typeof input === "number" ? input : typeof input === "string" ? Number(input) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.max(1, Math.min(max, Math.floor(n)));
}
