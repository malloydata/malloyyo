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
