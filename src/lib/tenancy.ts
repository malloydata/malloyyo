// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * Who is asking, as a Malloy given — and the rules that stop that answer being
 * turned off by accident.
 *
 * A model opts in by declaring the given and filtering on it:
 *
 *   ##! experimental { givens }
 *   given:
 *     MALLOYYO_EMAIL :: string is ''
 *     MALLOYYO_ROLES :: string[] is []
 *
 *   source: orders is ... extend { where: owner_email = $MALLOYYO_EMAIL }
 *
 * Filter on the SOURCE, not per query: the filter then rides on every query
 * anyone writes over it later, including ones an agent composes, and it is what
 * makes the usage gate below free rather than a tax.
 *
 * THE SUPPLY IS CORE'S JOB. The value goes on the per-request Runtime and the
 * name into `config.finalizeGivens` (src/lib/malloy.ts). Core then refuses a
 * per-query override, refuses to run when a finalized name has no value, and
 * hides the name from `Model.givens` so nothing offers to edit it. We used to
 * reimplement all three by stripping caller keys; we don't any more.
 *
 * WHAT IS OURS is making it impossible to quietly stop being scoped:
 *
 *   1. The DATASET records what it requires (`datasets.required_givens`),
 *      derived from the first model that declares it. A later publish that
 *      drops the declaration is REFUSED — see requirementForPublish below.
 *   2. The values are attached to EVERY lease on such a dataset, not only when
 *      the model still declares the name. Attaching conditionally is the branch
 *      that fails open: a model that stopped declaring it would simply stop
 *      being scoped. Attached unconditionally, core throws `unknown given` and
 *      the dataset goes dark instead.
 *   3. A query that never REFERENCES the given is refused (the gate in
 *      mcp-engine's host-givens). Declaration is not usage: an author can keep
 *      the `given:` and delete the `where:`, or extract a new source from a
 *      filtered one and leave the filter behind.
 *
 * None of this catches a filter that is referenced but cosmetic
 * (`select: e is $MALLOYYO_EMAIL`) or one that has been widened
 * (`or is_public`). Only running the same query under two identities catches
 * the first, and only review catches the second. Said plainly in
 * docs/multi-tenant-givens.md rather than papered over here.
 */

import type { GivenValue } from "@malloydata/malloy";

/**
 * The prefix this server owns. A model may not declare anything else under it,
 * and the rule is not tidiness — it is the one thing keeping this mechanism
 * monotonic.
 *
 * A supplied given may only NARROW. `$MALLOYYO_EMAIL` appears in an equality
 * filter: no value means no rows, a wrong value means one tenant's rows. Every
 * safety property here assumes that shape — the usage gate checks the given is
 * referenced, and "no value → refuse" is only safe for something that narrows.
 *
 * Authority WIDENS. `where: owner = $MALLOYYO_EMAIL or $MALLOYYO_ROLE = 'admin'`
 * references the given — so it passes the gate — while switching the scoping off
 * for whoever matches. It is exactly the widened filter nothing mechanical
 * catches, offered as the ergonomic default. So roles do not become givens: who
 * may open a dataset is a grant on the dataset, and what they see inside it is
 * this. Neither layer can undo the other, and that is the point.
 */
export const RESERVED_GIVEN_PREFIX = "MALLOYYO_";

/** The one reserved given that exists. The set is deliberately a list: the
    dataset column, the publish check and the lease all take collections, so a
    second one is a value change rather than a code change. */
export const TENANT_EMAIL_GIVEN = `${RESERVED_GIVEN_PREFIX}EMAIL`;
export const TENANT_ROLES_GIVEN = `${RESERVED_GIVEN_PREFIX}ROLES`;

export const SUPPLIED_GIVENS = [TENANT_EMAIL_GIVEN, TENANT_ROLES_GIVEN] as const;

export function isReservedGiven(name: string): boolean {
  return name.startsWith(RESERVED_GIVEN_PREFIX);
}

/** The reserved names a model declares. */
export function reservedDeclarations(declared: Iterable<string>): string[] {
  return [...declared].filter(isReservedGiven).sort();
}

/** Reserved names a model declares that this server does not fill. */
export function unsupportedReservedGivens(declared: Iterable<string>): string[] {
  return reservedDeclarations(declared).filter(
    (n) => !(SUPPLIED_GIVENS as readonly string[]).includes(n),
  );
}

export function reservedGivenError(names: string[]): string {
  return (
    `${names.join(", ")}: the \`${RESERVED_GIVEN_PREFIX}\` prefix is reserved for values ` +
    `Malloyyo supplies, and it fills ${SUPPLIED_GIVENS.join(", ")} today. ` +
    `Rename these givens, or drop the prefix if the dashboard supplies them itself.`
  );
}

export type RequirementDecision =
  | { ok: true; required: string[]; added: string[] }
  | { ok: false; error: string };

/**
 * What a dataset requires after this publish, or why the publish is refused.
 *
 * `current` is what the dataset already records; `declared` is what the model
 * being published declares. The asymmetry is the whole point:
 *
 *   - a name the model declares and the dataset does not → **recorded**. This is
 *     how a dataset becomes scoped: by someone publishing a model that says so,
 *     not by an admin remembering to tick a box.
 *   - a name the dataset requires and the model no longer declares → **refused**,
 *     because that publish would otherwise make the data unscoped. Removing a
 *     requirement is a deliberate act against the dataset, not a side effect of
 *     a push.
 */
export function requirementForPublish(
  current: readonly string[],
  declared: Iterable<string>,
): RequirementDecision {
  const unsupported = unsupportedReservedGivens(declared);
  if (unsupported.length > 0) return { ok: false, error: reservedGivenError(unsupported) };

  const declaredReserved = new Set(reservedDeclarations(declared));
  const dropped = current.filter((n) => !declaredReserved.has(n)).sort();
  if (dropped.length > 0) {
    return {
      ok: false,
      error:
        `${dropped.join(", ")}: this dataset is scoped by ${dropped.length > 1 ? "these givens" : "this given"}, ` +
        `and the model being published no longer declares ${dropped.length > 1 ? "them" : "it"}. ` +
        `Publishing it would return every row to every user. Restore the declaration ` +
        `(\`given: ${dropped[0]} :: string is ''\`) and the filter that uses it, or have an admin ` +
        `clear the requirement on the dataset first.`,
    };
  }

  const required = [...new Set([...current, ...declaredReserved])].sort();
  const added = required.filter((n) => !current.includes(n));
  return { ok: true, required, added };
}

/**
 * What a lease on this dataset carries: the values, and the names core locks.
 *
 * Unconditional for every name the dataset requires — see rule 2 above. An
 * account with no address supplies nothing for that name, which makes core
 * refuse the query rather than bind something permissive: `users.email` is
 * nullable, and an empty `filter<string>` means NO filter, so a default here
 * would hand every tenant's rows to the one caller we could not identify.
 */
export function leaseScope(
  required: readonly string[],
  user: { email: string | null; roles: string[] },
): { givens: Record<string, GivenValue>; finalize: readonly string[] } {
  const givens: Record<string, GivenValue> = {};
  for (const name of required) {
    // An address can be absent (users.email is nullable); a role list cannot —
    // everyone holds at least MALLOYYO_USER — so only the address has a
    // "supply nothing and let core refuse" branch.
    if (name === TENANT_EMAIL_GIVEN && user.email) givens[name] = user.email;
    if (name === TENANT_ROLES_GIVEN) givens[name] = user.roles as unknown as GivenValue;
  }
  return { givens, finalize: required };
}
