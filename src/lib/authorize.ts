// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The one interface for "may this person use this instance, and as what?" —
// two membership authorities behind it, chosen by who owns sign-in.
//
// Where the application owns sign-in, membership is the `users` table:
// `status === 'active'` admits, `role` answers what they may do, and
// BREAK_GLASS_EMAIL is the emergency door (admit this person regardless —
// named after what it does, so no variable ever changes meaning; the retired
// EMAIL_ALLOW_LIST meant the opposite when set).
//
// Where an integration owns sign-in, its own membership already admitted the
// session — a second list here could only disagree with it, and would disagree
// in the worst direction, since such a session may carry no email address at
// all. The application's remaining say is revocation: a `disabled` row refuses
// whatever the token claims, instantly, with no provider round-trip.
//
// Callers hand this a row they read from the database ON THIS REQUEST.
// That per-request read is a requirement, not an optimization target: anything
// that caches the user on the session token silently restores token expiry as
// the revocation bound. getSessionUser() and the MCP token path both read the
// row fresh; keep it that way.
//
// Deliberately free of the session machinery and the database (the row comes
// in as an argument), so src/auth.ts and src/lib/user.ts can both use it
// without an import cycle.

import type { User, UserRole } from "@/db";
import { hostedSignIn } from "./hosted-auth-integration";

export type Authorization =
  | { allowed: true; role: UserRole; breakGlass?: true }
  | { allowed: false; reason: "pending" | "disabled" };

/** The emergency door's address, or null when the door is closed. */
function breakGlassEmail(): string | null {
  const v = process.env.BREAK_GLASS_EMAIL?.trim().toLowerCase();
  return v ? v : null;
}

/** Membership per the application's own `users` table. */
export function ossAuthorize(user: User): Authorization {
  // Break-glass admits regardless of row state — its whole job is to let an
  // operator back in when the data says no. Admin, not owner: the door opens
  // the instance, it doesn't transfer it.
  const breakGlass = breakGlassEmail();
  if (breakGlass && user.email?.toLowerCase() === breakGlass) {
    return { allowed: true, role: user.role === "owner" ? "owner" : "admin", breakGlass: true };
  }
  if (user.status === "active") return { allowed: true, role: user.role };
  return { allowed: false, reason: user.status === "disabled" ? "disabled" : "pending" };
}

/**
 * Membership where an integration owns sign-in: the provider admits, we deny.
 * A row exists because the provider authenticated this person for this
 * deployment; the only local answer is the `disabled` mirror — revocation that
 * takes effect now rather than at token expiry. No second admission list, no
 * approval queue, and no break-glass here (the provider carries its own).
 */
export function hostedAuthorize(user: User): Authorization {
  if (user.status === "disabled") return { allowed: false, reason: "disabled" };
  return { allowed: true, role: user.role };
}

export function authorize(user: User): Authorization {
  return hostedSignIn() ? hostedAuthorize(user) : ossAuthorize(user);
}
