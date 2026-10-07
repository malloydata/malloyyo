// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// MIRROR of packages/mcp-engine/src/truncation.ts — the row-limit notice a
// static site (frame-wasm-entry.tsx) attaches when its cap cut a result, so it
// reads the same as the dev server's and the hosted app's. A copy for the same
// reason as ./json-rows: frame sources ship as source and cannot import a
// workspace package. packages/cli/test/row-limit.test.ts pins the two together.

export interface RowLimitNotice {
  reason: "row_limit";
  hint: string;
}

export function rowLimitTruncation(rowLimit: number): RowLimitNotice {
  return {
    reason: "row_limit",
    hint:
      `Result hit the ${rowLimit}-row limit; more rows may exist. ` +
      "Aggregate, filter, or do top-N in Malloy rather than fetching " +
      "rows to post-process.",
  };
}
