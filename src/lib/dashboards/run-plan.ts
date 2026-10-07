// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Where a dashboard run request's text gets compiled, and under which compiler.
//
// A LEAF module on purpose: no database, no Malloy, no engine. `./engine`
// imports `@/db`, which reads DATABASE_URL at import time, so a test importing
// these functions from there needs a live environment to assert on a pure
// conditional. Same split, and the same reason, as `@/lib/repo-names` beside
// `@/lib/repos`.
//
// This is a security boundary expressed as a conditional, which is why it is
// its own module with its own test (engine-run-plan.test.ts) rather than three
// lines inside `runDashboard`.

/** Does this text read as a complete Malloy query rather than an expression? */
export function isMalloyText(s: string): boolean {
  return /^\s*run\s*:/.test(s);
}

/**
 * The run-expressions a stored dashboard declares — its tiles, or its single
 * `query`.
 *
 * This is the allow-list for the UNRESTRICTED run path. A manifest arrives from
 * a published repo, which only a dataset's owner or an admin can push, so its
 * text carries the same authority as the model it ships beside. Text that
 * arrives in a REQUEST carries the authority of whoever is signed in, which is
 * much less.
 *
 * Non-strings are dropped rather than coerced: a manifest is stored JSON, and a
 * number or object left in `tiles` must not become runnable text.
 */
export function declaredRuns(manifest: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof manifest.query === "string") out.push(manifest.query);
  if (Array.isArray(manifest.tiles)) {
    for (const t of manifest.tiles) if (typeof t === "string") out.push(t);
  }
  return out;
}

export type DashboardRunPlan =
  | { kind: "restricted"; text: string }
  | { kind: "declared"; run: string }
  | { kind: "none" };

/**
 * Decide the compiler by PROVENANCE, not by spelling.
 *
 * The previous rule was wrong in a way that read as deliberate: text in `query`
 * reached the restricted compiler only when it began with `run:`, and otherwise
 * the open one. So a caller picked its own compiler by picking punctuation, and
 * a bare run-expression could name constructs the restricted gate exists to
 * refuse — in DuckDB, raw SQL is filesystem access.
 *
 *  - `declared` — the request named one of the manifest's own expressions. The
 *    MANIFEST's copy is what runs, so a near-match contributes nothing.
 *  - `restricted` — anything else a request supplies, `run:`-prefixed or not.
 *    The same gate `/api/run` has always used.
 *  - `none` — no request text and nothing declared.
 */
export function planDashboardRun(
  manifest: Record<string, unknown>,
  req: { query?: string; malloy?: string },
): DashboardRunPlan {
  // An explicit `malloy` field has always meant restricted text.
  if (typeof req.malloy === "string") return { kind: "restricted", text: req.malloy };

  if (typeof req.query === "string") {
    const wanted = req.query.trim();
    const match = declaredRuns(manifest).find((d) => d.trim() === wanted);
    if (match !== undefined) return { kind: "declared", run: match };
    return { kind: "restricted", text: isMalloyText(req.query) ? req.query : `run: ${req.query}` };
  }

  if (typeof manifest.query === "string") return { kind: "declared", run: manifest.query };
  return { kind: "none" };
}
