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
 */
export function resolveHostGivens(
  caller: Record<string, unknown> | undefined,
  host: HostGivens | undefined,
  declared: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  if (!host) return caller;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(caller ?? {})) {
    if (isHostsToFill(k, host)) continue;
    out[k] = v;
  }
  for (const [k, v] of Object.entries(host.values)) {
    if (declared.has(k)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
