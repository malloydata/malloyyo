// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * Givens the HOST supplies, which a caller may not choose.
 *
 * A multi-tenant host wants a model to be able to write `$MALLOYYO_EMAIL` and
 * have it mean "whoever is asking" — never "whoever the request said". Two
 * facts about Malloy's own binder shape this (both measured, not assumed):
 *
 *   - Per-query supply OVERLAYS the runtime layer, so a caller-supplied value
 *     wins. Supplying the identity at the runtime level is therefore not
 *     enough on its own; the caller's key has to go.
 *   - Supplying a given the MODEL DOES NOT DECLARE is an error
 *     (`unknown given 'X'. Model surfaces [...]`), not a no-op. So the host's
 *     value can only be attached when the model asked for it — which is also
 *     exactly the opt-in we want: a model joins the scheme by declaring the
 *     given, and every other model is untouched.
 *
 * Malloy ships a stronger primitive for this, `config.finalizeGivens`: it makes
 * a per-query override THROW and hides the name from introspection. It lives on
 * the Runtime, though, and a host that pools one runtime per model across users
 * (as the hosted app does) would have to fragment that pool per user to use it.
 * Until that trade is worth making, the host enforces the same invariant here,
 * which is why this module is the one place the merge happens.
 */

import type { GivenValue } from '@malloydata/malloy';

export interface HostGivens {
  /** Name → value. Bound only for the names a model declares. */
  values: Record<string, GivenValue>;
  /**
   * Names under this prefix belong to the host, whether or not it fills them.
   * A caller's value for one is dropped rather than bound, so a model that
   * declares a reserved name the host does NOT fill falls back to its
   * declaration default instead of becoming a caller-settable field that looks
   * like the host vouches for it.
   */
  reservedPrefix?: string;
}

function isHostsToFill(name: string, host: HostGivens): boolean {
  return (
    name in host.values ||
    (host.reservedPrefix !== undefined && name.startsWith(host.reservedPrefix))
  );
}

export type HostGivensResult =
  | { ok: true; givens: Record<string, unknown> | undefined }
  /** Reserved names this model declares that the host cannot fill right now. */
  | { ok: false; missing: string[] };

/**
 * The givens to actually supply: the caller's, minus every reserved name,
 * plus the host's values for the names this model declares.
 *
 * `declared` is the model's own surface (`Model.givens`). A host value for a
 * name outside it is dropped rather than passed through — supplying it would
 * fail the query with "unknown given", and a model that never asked to be
 * tenant-scoped should not start erroring because the host has an identity to
 * offer.
 *
 * A caller's reserved-name key is dropped whether or not the model declares it:
 * the name is the host's to fill, and silently ignoring the caller is the
 * correct answer to a request that should never have carried it.
 *
 * FAILS CLOSED. A reserved name the model declares but the host cannot fill
 * comes back as `missing`, and the caller refuses the query. Falling through to
 * the declaration default looks safer than it is: the project's own guidance is
 * to declare filters as `filter<T>`, and an EMPTY filter means "no filter" — so
 * a tenant-scoped source whose identity went unsupplied would return every row
 * rather than none. Verified against a real compile: `filter<string>` bound to
 * an address returns that row, bound to '' returns all of them.
 */
export function resolveHostGivens(
  caller: Record<string, unknown> | undefined,
  host: HostGivens | undefined,
  declared: ReadonlySet<string>,
): HostGivensResult {
  if (!host) return { ok: true, givens: caller };
  const missing = [...declared].filter((n) => isHostsToFill(n, host) && !(n in host.values)).sort();
  if (missing.length > 0) return { ok: false, missing };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(caller ?? {})) {
    if (isHostsToFill(k, host)) continue;
    out[k] = v;
  }
  for (const [k, v] of Object.entries(host.values)) {
    if (declared.has(k)) out[k] = v;
  }
  return { ok: true, givens: Object.keys(out).length > 0 ? out : undefined };
}

/**
 * What to tell a caller whose query needs a host value that isn't available.
 *
 * Deliberately says nothing about HOW to supply it: on an instance the answer
 * is "sign in with an address" and there is nothing the caller can do, while in
 * the CLI it is `malloyyo.test_givens`. The host that knows which world it is
 * in appends that (packages/cli/src/host.ts does).
 */
export const HOST_GIVEN_UNAVAILABLE = 'host-given-unavailable';

export function missingHostGivensMessage(missing: string[]): string {
  return (
    `${missing.join(", ")}: filled by the host, not by the query, and no value is ` +
    `available for this request. Refused rather than run on the declaration ` +
    `default, which may not be restrictive.`
  );
}

/** The names a model declares, as the binder sees them. */
export function declaredGivenNames(model: {
  givens?: ReadonlyMap<string, unknown>;
}): ReadonlySet<string> {
  return new Set(model.givens?.keys() ?? []);
}

/**
 * Introspection minus the host's names.
 *
 * `query(execute:false)` reports the givens a query needs so an agent can
 * supply them, and a dashboard renders a control for each. Neither should
 * happen for a name the host fills: the agent would waste a turn on a value
 * that gets dropped, and the reader would be handed an identity box to type in.
 */
export function withoutHostGivens<T extends { name: string }>(
  specs: readonly T[],
  host: HostGivens | undefined,
): T[] {
  if (!host) return [...specs];
  return specs.filter((s) => !isHostsToFill(s.name, host));
}
