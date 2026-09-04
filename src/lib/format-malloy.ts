// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Canonical formatting for AGENT-written Malloy.
//
// A model writes whatever compiles, and what compiles includes an entire query
// on one line with semicolons between the clauses. It runs correctly and it is
// unreadable — and this text is not scratch: it lands in history, in the ltool
// editor, and in a shared link, where a person reads it and edits it.
//
// So it is formatted by the compiler's own prettifier rather than by asking the
// model nicely. Prompting for a formatting convention costs tokens on every
// turn and holds only as well as the model's attention does; this holds always,
// and it is the same canonical form the authoring surface's `prettify` tool
// emits, so a query written here and a query written there look alike.
//
// NOT applied to Malloy a person typed. Reformatting someone's own text under
// them as they hit Run is a different thing entirely, and unwelcome.

import { prettify } from "@malloyyo/mcp-engine";

/** The canonical form of `src`, or `src` unchanged if it cannot be formatted.
 *
 *  Formatting is a nicety and the query is the point: anything unexpected —
 *  a parse problem, empty output, a throw from the experimental entry point —
 *  returns the original rather than risking the run. */
export function formatMalloy(src: string): string {
  try {
    const { formatted, problems } = prettify(src);
    if (problems.length > 0 || !formatted.trim()) return src;
    return formatted.trimEnd();
  } catch {
    return src;
  }
}
