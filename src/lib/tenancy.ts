// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * Who is asking, as a Malloy given.
 *
 * A model opts into multi-tenancy by declaring the given and using it:
 *
 *   ##! experimental.givens
 *   given:
 *     MALLOYYO_EMAIL :: string is ''
 *
 *   source: orders is ... extend {
 *     where: owner_email = $MALLOYYO_EMAIL
 *   }
 *
 * On this server, every run of that model binds it to the signed-in user's
 * address. A model that does not declare it is untouched — supplying a given a
 * model never declared is an error in Malloy, not a no-op, so the declaration
 * IS the opt-in.
 *
 * THE SECURITY PROPERTY, and the two ways it could be lost:
 *
 *   1. Per-query givens overlay the runtime layer in Malloy, so a caller's
 *      value would win. Every MALLOYYO_* key a caller sends is therefore
 *      dropped before the merge (resolveHostGivens), not merged under ours.
 *   2. `test_givens` in a repo's malloy-config.json is author-supplied and would
 *      otherwise let a repo name any address it liked. It is a LOCAL stand-in,
 *      read by the CLI so an author can run a tenant-scoped model before
 *      publishing (packages/cli/src/test-givens.ts). Nothing here may consult
 *      it: the block travels with the model like any other file, and the only
 *      thing keeping it inert on this server is that no server code reads it.
 *
 * Only MALLOYYO_EMAIL exists today. Any other MALLOYYO_* declaration is
 * refused rather than ignored: the prefix is reserved for values this server
 * vouches for, and a model that declared MALLOYYO_ROLE would otherwise read as
 * though the server were filling it.
 */

import type { HostGivens } from "@malloyyo/mcp-engine";

/** The prefix this server owns. A model may not declare anything else under it. */
export const RESERVED_GIVEN_PREFIX = "MALLOYYO_";

/** The one reserved given that exists. */
export const TENANT_EMAIL_GIVEN = "MALLOYYO_EMAIL";

export function isReservedGiven(name: string): boolean {
  return name.startsWith(RESERVED_GIVEN_PREFIX);
}

/**
 * What this server fills in for a request made by `user`.
 *
 * Always returns the value, whether or not the model declares the given —
 * resolveHostGivens drops it for a model that doesn't, and passing it
 * unconditionally keeps the "who is asking" answer in one place.
 */
export function hostGivensFor(user: { email: string | null }): HostGivens {
  return {
    values: { [TENANT_EMAIL_GIVEN]: user.email ?? "" },
    reservedPrefix: RESERVED_GIVEN_PREFIX,
  };
}

/**
 * The reserved names a model declares that this server does not fill, or null
 * when the model is fine.
 *
 * Checked at publish AND at run: publish is where an author should hear it, but
 * a model published before this rule existed would otherwise keep running with
 * a $MALLOYYO_ROLE that nothing supplies and everything appears to.
 */
export function unsupportedReservedGivens(declared: Iterable<string>): string[] {
  return [...declared].filter((n) => isReservedGiven(n) && n !== TENANT_EMAIL_GIVEN).sort();
}

/** The message an author gets for one, wherever it is caught. */
export function reservedGivenError(names: string[]): string {
  return (
    `${names.join(", ")}: the \`${RESERVED_GIVEN_PREFIX}\` prefix is reserved for values ` +
    `Malloyyo supplies, and \`${TENANT_EMAIL_GIVEN}\` is the only one it fills today. ` +
    `Rename these givens, or drop the prefix if the dashboard supplies them itself.`
  );
}
