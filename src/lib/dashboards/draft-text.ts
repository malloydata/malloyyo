// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The text side of a draft dashboard file — what the restricted gate sees, and
// what is stored. Pure string work, no runtime or database, so ./draft (which
// has both) and its tests share one definition.

/** The one import a draft dashboard file may carry: the model's own entry. */
const INDEX_IMPORT_RE = /^[ \t]*import[ \t]+(["'])\.\.\/index\.malloy\1[ \t]*;?[ \t]*$/gm;

/**
 * The compiler flags a draft dashboard file may set. Restricted mode forbids
 * `##!` outright, but a dashboard using givens can't compile without the
 * givens flag in its own file — every real dashboard file starts with it.
 * These two switch on language features (given references, access
 * modifiers); neither widens what the file can reach, which is what the gate
 * is about. Any other `##!` content stays in the body and is rejected.
 */
const ALLOWED_EXPERIMENTS = new Set(["givens", "access_modifiers"]);
const FLAG_LINE_RE = /^[ \t]*##!(.*)$/gm;

/**
 * The experiments a `##!` line turns on, if that is ALL it does — else null.
 * Malloy takes both spellings, and the models and help pages use both:
 * `experimental.givens` (several per line allowed) and
 * `experimental { givens access_modifiers }`.
 */
function experimentsOnly(flags: string): string[] | null {
  const names: string[] = [];
  const rest = flags.replace(/experimental[ \t]*\{([^}]*)\}/g, (_, inner: string) => {
    names.push(...inner.split(/[\s,]+/).filter(Boolean));
    return " ";
  });
  for (const token of rest.split(/\s+/).filter(Boolean)) {
    const m = /^experimental\.([A-Za-z_]\w*)$/.exec(token);
    if (!m) return null;
    names.push(m[1]);
  }
  return names.length > 0 ? names : null;
}

/** The file minus its `import "../index.malloy"` and its allowed `##!`
    experiment lines — what the gate checks. */
export function draftBody(malloy: string): string {
  return malloy.replace(INDEX_IMPORT_RE, "").replace(FLAG_LINE_RE, (line, flags: string) => {
    const names = experimentsOnly(flags);
    return names && names.every((n) => ALLOWED_EXPERIMENTS.has(n)) ? "" : line;
  });
}

/**
 * The file as stored: with the givens flag added when it references a given
 * and doesn't turn the flag on itself. The query tool never asks for the flag
 * (restricted text inherits index.malloy's), so an author coming from it
 * writes `$CATEGORY` and nothing else — and the whole-file compile then fails
 * on a flag they had no reason to know about. Stored, not just compiled, so
 * the draft still promotes into a repo as a file that compiles.
 */
export function draftFile(malloy: string): string {
  if (!/\$[A-Za-z_]/.test(malloy)) return malloy;
  for (const m of malloy.matchAll(FLAG_LINE_RE)) {
    if (experimentsOnly(m[1])?.includes("givens")) return malloy;
  }
  return `##! experimental.givens\n${malloy}`;
}

/** One find/replace change to a stored draft file: `source` unless `file` says `malloy`. */
export interface DraftEdit {
  find: string;
  replace: string;
  file?: "source" | "malloy";
}

/**
 * Apply edits to a draft's stored files, in order, so a small change need not
 * resend the whole file. Each `find` must match exactly once; any failing edit
 * fails them all, and the error names it.
 */
export function applyDraftEdits(
  files: { source: string; malloy: string },
  edits: DraftEdit[],
): { ok: true; source: string; malloy: string } | { ok: false; error: string } {
  const out = { ...files };
  for (const [i, e] of edits.entries()) {
    const fail = (why: string) => ({ ok: false as const, error: `edit ${i + 1}: ${why}; nothing was saved` });
    if (typeof e?.find !== "string" || typeof e.replace !== "string") return fail("expected { find, replace } strings");
    if (!e.find) return fail("'find' is empty");
    if (e.file !== undefined && e.file !== "source" && e.file !== "malloy") return fail("'file' must be source or malloy");
    const file = e.file ?? "source";
    const at = out[file].indexOf(e.find);
    if (at < 0) return fail(`'find' is not in the draft's ${file}`);
    if (out[file].indexOf(e.find, at + 1) >= 0) {
      return fail(`'find' matches more than once in the draft's ${file}; include more of the text around it`);
    }
    out[file] = out[file].slice(0, at) + e.replace + out[file].slice(at + e.find.length);
  }
  return { ok: true, ...out };
}
