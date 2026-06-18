// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Whether a Malloy identifier must be backtick-quoted to be written — a
// reserved word, or not a bare identifier (funny characters / leading digit).
//
// TEMPORARY: RESERVED_WORDS is a verbatim copy of `@malloydata/malloy-
// interfaces` RESERVED_WORDS (v0.0.410, 76 entries) and `needsQuote` mirrors
// its `shouldQuoteIdentifier`. Replace this whole module with an import once
// those are exported from a public root (today they are reachable only via
// `@malloydata/malloy-interfaces/dist/*` subpaths, and not from malloy core).
// See brain mcp-fox-mode/quoted-identifiers.md.

const RESERVED_WORDS: ReadonlySet<string> = new Set([
  'all', 'and', 'as', 'asc', 'avg', 'boolean', 'by', 'case', 'cast', 'compose',
  'count', 'date', 'day', 'days', 'desc', 'distinct', 'else', 'end', 'exclude',
  'export', 'extend', 'false', 'filter', 'for', 'from', 'full', 'has', 'hour',
  'hours', 'import', 'in', 'include', 'inner', 'internal', 'is', 'json', 'left',
  'like', 'max', 'min', 'minute', 'minutes', 'month', 'months', 'not', 'now',
  'null', 'number', 'on', 'or', 'pick', 'private', 'public', 'quarter',
  'quarters', 'right', 'second', 'seconds', 'source', 'sql', 'string', 'sum',
  'table', 'then', 'this', 'timestamp', 'timestamptz', 'to', 'true', 'virtual',
  'week', 'weeks', 'when', 'with', 'year', 'years',
]);

const BARE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * True when `name` must be backtick-quoted to appear in Malloy: a reserved
 * word, or not a legal bare identifier (characters other than
 * letters/digits/underscore, or a leading digit).
 */
export function needsQuote(name: string): boolean {
  return !BARE_IDENTIFIER.test(name) || RESERVED_WORDS.has(name.toLowerCase());
}
