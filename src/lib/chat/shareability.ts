// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Whether a chat held on a dataset may be shown to anyone but its author.
//
// A LEAF module: no database, no Malloy. `./store` imports `@/db`, which reads
// DATABASE_URL at import time, so a test importing this from there would need a
// live environment to assert on two field checks. Same split, same reason, as
// `@/lib/dashboards/run-plan` and `@/lib/repo-names`.

/** Why a chat cannot be shared, or that it can. A discriminated union rather
    than a boolean so a caller must read `.ok` — and so the refusal can be
    explained in the words of the person who tried. */
export type ChatShareability =
  | { ok: true }
  | { ok: false; reason: "unresolvable" | "not-public" | "row-scoped" };

/**
 * Two conditions, and the second is the one that was missing.
 *
 * A published chat stores its RESULT ROWS and serves them to every signed-in
 * reader. Row scoping is per viewer — `required_givens` finalizes values like
 * MALLOYYO_EMAIL on the runtime, so each person sees only their own rows — so
 * "public" on such a dataset means "anyone may OPEN it", never "anyone may see
 * these rows". That is the multi-tenant pattern the givens feature exists for.
 * Gating publication on `is_public` alone let one tenant hand every other
 * signed-in user their own rows, through a self-service toggle that gave no
 * indication it did so.
 *
 * `not-public` is checked first: when a dataset is both private and scoped,
 * private is the more fundamental answer and the plainer thing to say.
 */
export function shareabilityOf(ds: {
  isPublic: boolean | null;
  requiredGivens: string[] | null;
}): ChatShareability {
  if (ds.isPublic !== true) return { ok: false, reason: "not-public" };
  if ((ds.requiredGivens ?? []).length > 0) return { ok: false, reason: "row-scoped" };
  return { ok: true };
}
