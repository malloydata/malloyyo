// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Adapter for the experimental Malloy prettifier on the /internal entry
// point (no stability commitment; expected to move to @malloydata/syntax).
// Keep this the only file that imports it so the migration is one edit.

import { prettify as internalPrettify } from '@malloydata/malloy/internal';
import type { Problem } from './types';

export interface PrettifyOutcome {
  /** Best-effort when problems is non-empty — fix parse errors first. */
  formatted: string;
  problems: Problem[];
}

type PrettifyErrorShape = {
  message: string;
  line?: number;
  column?: number;
};

export function prettify(source: string): PrettifyOutcome {
  const { result, errors } = internalPrettify(source);
  const problems: Problem[] = (errors as PrettifyErrorShape[]).map((e) => ({
    severity: 'error',
    code: 'parse-error',
    message: e.message,
    line: e.line,
    column: e.column,
  }));
  return { formatted: result, problems };
}
