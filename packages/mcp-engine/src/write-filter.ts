// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// write_filter: a description → a Malloy filter expression, for the explorer's
// filter boxes (tier 2 — tier 1 is "the text already parses, use it").
//
// PURE. This module builds the prompt and reads the answer; the HOST makes the
// model call (the CLI dev server with fetch, the hosted app with its SDK) and
// validates the result with `@malloydata/malloy-filter` before handing it to
// the frame. The language reference the model reads is the same help topic a
// human gets from `yo_help("language/filter-expressions")`, so the two can't
// drift.

import { contentFiles } from './content/generated';

export interface WriteFilterRequest {
  /** The field being filtered, as the user sees it (`st.region`). */
  field: string;
  /** Malloy type: string | number | boolean | date | timestamp | timestamptz. */
  type: string;
  /** What the user typed. */
  description: string;
  /** Some values the field takes, when known (string fields). Lets "west coast"
      become `CA, OR, WA` from the values that actually exist. */
  values?: string[];
  /** The source's measure/dimension context, one line, optional. */
  source?: string;
  /** Today's date (YYYY-MM-DD) so relative phrases resolve. */
  today?: string;
}

export interface WriteFilterAnswer {
  /** The filter expression source (what goes inside `f'…'`), or undefined when
      the model said the description can't be expressed. */
  text?: string;
  /** One line the UI can show: what the expression means, or why there is none. */
  note?: string;
}

const REFERENCE_KEY = 'language/filter-expressions.md';

/** The filter-language reference, as shipped in the help content. */
export function filterLanguageReference(): string {
  return contentFiles[REFERENCE_KEY] ?? '';
}

const familyOf = (type: string): string =>
  type === 'date' || type === 'timestamp' || type === 'timestamptz' ? 'date and timestamp' : type;

/** The messages for the model: a system prompt carrying the reference and the
    output contract, and one user turn with the request. The answer contract is
    two lines — `filter: <expression>` (or `filter: none`) and `note: <one
    line>` — chosen so a host can read it without a JSON mode. */
export function writeFilterPrompt(req: WriteFilterRequest): { system: string; user: string } {
  const system = [
    'You translate a description into a Malloy FILTER EXPRESSION for one field.',
    'The complete language is below; nothing outside it is valid. Answer with',
    'exactly two lines and nothing else:',
    '',
    'filter: <the expression, or the word none>',
    'note: <one short line: what it means, or why it cannot be expressed>',
    '',
    'Never answer with SQL, Malloy operators, or prose on the filter line.',
    'Prefer the simplest form that means exactly what was asked. When the',
    'description names a set (a region, a category of things), use the listed',
    'values that belong to it. When it implies a threshold with no number, pick',
    'a round one and say so in the note.',
    '',
    '----- REFERENCE -----',
    filterLanguageReference(),
  ].join('\n');
  const lines = [
    `Field: ${req.field}`,
    `Type: ${req.type} (use the "${familyOf(req.type)}" language)`,
    ...(req.source ? [`Source: ${req.source}`] : []),
    ...(req.today ? [`Today: ${req.today}`] : []),
    ...(req.values && req.values.length
      ? [`Some values this field takes: ${req.values.slice(0, 60).join(', ')}`]
      : []),
    `Description: ${req.description}`,
  ];
  return { system, user: lines.join('\n') };
}

/** Read the model's two-line answer. Tolerant of stray formatting (code fences,
    an `f'…'` wrapper, trailing prose) — the host validates with the parser
    afterwards anyway. */
export function parseWriteFilterAnswer(raw: string): WriteFilterAnswer {
  const text = raw.replace(/```[a-z]*\n?/g, '').trim();
  const out: WriteFilterAnswer = {};
  const f = /^\s*filter:\s*(.*)$/im.exec(text);
  const n = /^\s*note:\s*(.*)$/im.exec(text);
  if (f) {
    let expr = (f[1] ?? '').trim();
    const wrapped = /^f?'(.*)'$/.exec(expr);
    if (wrapped) expr = wrapped[1] ?? '';
    expr = expr.replace(/^`|`$/g, '').trim();
    if (expr && expr.toLowerCase() !== 'none') out.text = expr;
  }
  if (n) out.note = (n[1] ?? '').trim();
  if (!f && !n && text && !/\n/.test(text)) {
    // A bare one-line answer: treat it as the expression.
    out.text = text.replace(/^f?'(.*)'$/, '$1');
  }
  return out;
}
