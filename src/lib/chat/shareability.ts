// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Whether a chat held on a dataset may be shown to anyone but its author.
//
// A LEAF module: no database, no Malloy. `./store` imports `@/db`, which reads
// DATABASE_URL at import time, so a test importing this from there would need a
// live environment to assert on two field checks. Same split, same reason, as
// `@/lib/dashboards/run-plan` and `@/lib/repo-names`.

import { openToMembers } from "../role-access";

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
 * "open to every member" on such a dataset means "anyone may OPEN it", never
 * "anyone may see these rows". That is the multi-tenant pattern the givens
 * feature exists for. Gating publication on openness alone let one tenant hand
 * every other signed-in user their own rows, through a self-service toggle that
 * gave no indication it did so.
 *
 * "Open to every member" is the members role at full (`openToMembers`,
 * src/lib/role-access.ts — a leaf like this one). It was the `is_public` flag,
 * which nothing reads any more; the reason is still called `not-public`.
 *
 * `not-public` is checked first: when a dataset is both closed and scoped,
 * closed is the more fundamental answer and the plainer thing to say.
 */
export function shareabilityOf(ds: {
  roles: readonly string[] | null;
  viewOnlyRoles: readonly string[] | null;
  requiredGivens: string[] | null;
}): ChatShareability {
  if (!openToMembers(ds)) return { ok: false, reason: "not-public" };
  if ((ds.requiredGivens ?? []).length > 0) return { ok: false, reason: "row-scoped" };
  return { ok: true };
}
