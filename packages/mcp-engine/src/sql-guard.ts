// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Read-only SQL gate for the raw-query tool: accept exactly one
// SELECT/WITH/FROM statement, refuse everything else. Comments are stripped
// FIRST so DDL can't hide behind `--` or `/* */`; a verb blocklist catches
// writes smuggled after a CTE (`WITH x AS (...) INSERT ...`). The blocklist
// errs toward refusal: a pure SELECT mentioning a blocked word (say, a column
// literally named "update") is rejected with a rephrase hint — safe beats
// clever for a tool exposed to arbitrary agents.

const WRITE_VERBS =
  /\b(insert|update|delete|create|drop|alter|attach|detach|copy|export|install|load|set|call|pragma|truncate|merge|grant|revoke|use|begin|commit|vacuum)\b/i;

/** Return undefined if `sql` is a single read-only statement, else the
    rejection message to show the caller. */
export function checkSelectOnly(sql: string): string | undefined {
  let s = sql.replace(/--[^\n]*/g, ' ');
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
  s = s.replace(/;+\s*$/, '').trim();
  if (!s) return 'Empty query.';
  if (s.includes(';')) return "Rejected: one statement per call (found ';').";
  const first = s.split(/\s+/, 1)[0]!.toLowerCase();
  if (first !== 'select' && first !== 'with' && first !== 'from') {
    return `Rejected: read-only server — statement starts with '${first}', not SELECT/WITH/FROM.`;
  }
  const m = WRITE_VERBS.exec(s);
  if (m) {
    return (
      `Rejected: read-only server — found '${m[0]}'. ` +
      '(If that word is only a string literal or identifier in a pure SELECT, rephrase to avoid it.)'
    );
  }
  return undefined;
}
