// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The row-limit notice. Hitting rowLimit is the only sign rows were cut (a
// result of exactly rowLimit rows reads as cut too), so every host that runs
// with a cap says so with this one object rather than its own wording.
// MIRRORED in packages/cli/src/shared/row-limit.ts for the frame sources,
// which cannot import a workspace package; packages/cli/test/row-limit.test.ts
// pins the two together.

import type { TruncationInfo } from './types';

export function rowLimitTruncation(rowLimit: number): TruncationInfo {
  return {
    reason: 'row_limit',
    hint:
      `Result hit the ${rowLimit}-row limit; more rows may exist. ` +
      'Aggregate, filter, or do top-N in Malloy rather than fetching ' +
      'rows to post-process.',
  };
}
