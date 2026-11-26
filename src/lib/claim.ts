// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// A first sign-in claiming the row an admin added for that address.
//
// Admin → Users → Add user creates the person — a `users` row with the roles
// ticked for them and `first_signed_in_at` NULL (src/lib/roster.ts). When they
// sign in for the first time, that row has to become theirs. Auth.js will not
// do it: finding a row with the profile's email and no link to this provider
// account, it refuses the sign-in ("another account already exists with the
// same e-mail address") unless told to link by email — and its switch for that
// (`allowDangerousEmailAccountLinking`) links to ANY row with that address,
// including one that has been signing in with a different provider for a year.
//
// So the link is made here, before Auth.js looks, and only in the one case it
// is meant for:
//
//   - the row has NEVER signed in (`first_signed_in_at IS NULL`). An
//     established account is never touched: for it, Auth.js's refusal stands
//     exactly as before.
//   - the row is active and not one an integration created.
//   - THE PROVIDER'S WORD FOR THE ADDRESS CAN BE TRUSTED (`emailIsTrusted`).
//     Claiming by email is exactly as strong as that: a provider that lets its
//     user assert an address they do not control would let them walk in as
//     whoever was added — with whatever roles were ticked, admin included.
//
// Once linked, the rest of the sign-in is the ordinary one for a returning
// user: Auth.js finds the account, no "user created" event fires, and so
// admission (src/lib/admission.ts) — which decides about rows nobody has
// decided about — never runs for someone an admin already decided about.

import { and, eq, isNull, sql } from "drizzle-orm";
import { accounts, db, users } from "@/db";
import { logger } from "./logger";

/**
 * May a sign-in through this provider claim a row by the email it asserts?
 *
 *   google              yes, when Google says the address is verified.
 *   okta                yes: the organization's own directory. (Refused only if
 *                       it explicitly says the address is unverified.)
 *   microsoft-entra-id  ONLY when sign-in is restricted to one tenant
 *                       (AUTH_MICROSOFT_ENTRA_ID_ISSUER). With the "common"
 *                       authority any Microsoft tenant can sign in, and the
 *                       admin of one can set a user's mail to anything.
 *   anything else       no. A provider is trusted here by being named here.
 */
export function emailIsTrusted(provider: string, profile: Record<string, unknown> | null | undefined): boolean {
  switch (provider) {
    case "google":
      return profile?.email_verified === true;
    case "okta":
      return profile?.email_verified !== false;
    case "microsoft-entra-id":
      return !!process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER?.trim();
    default:
      return false;
  }
}

/** The provider names whose sign-ins CANNOT claim an added row on this
    instance as configured — for the Add user dialog to say so, instead of
    someone discovering it when their sign-in is refused. */
export function providersThatCannotClaim(ready: readonly string[]): string[] {
  return ready.filter((p) => p === "microsoft-entra-id" && !process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER?.trim());
}

export interface ClaimAccount {
  provider: string;
  providerAccountId: string;
  type: string;
  refresh_token?: string | null;
  access_token?: string | null;
  expires_at?: number | null;
  token_type?: string | null;
  scope?: string | null;
  id_token?: string | null;
  session_state?: unknown;
}

/**
 * Link this provider account to the row an admin added for `email`, if there is
 * one to claim. Returns the user id that was claimed, or null — which is the
 * answer for every ordinary sign-in, and means "carry on as you would have".
 *
 * One transaction: the row is marked signed-in and the account linked together,
 * or neither. The UPDATE is the claim — `first_signed_in_at IS NULL` in its
 * WHERE means two racing sign-ins cannot both take one row.
 */
export async function claimAddedUser(input: {
  email: string | null | undefined;
  account: ClaimAccount;
  trusted: boolean;
  name?: string | null;
  image?: string | null;
}): Promise<string | null> {
  const email = input.email?.trim().toLowerCase();
  if (!email || !input.trusted) return null;

  return db.transaction(async (tx) => {
    // Already linked to someone: an ordinary returning sign-in. Nothing to do.
    const [linked] = await tx
      .select({ userId: accounts.userId })
      .from(accounts)
      .where(
        and(eq(accounts.provider, input.account.provider), eq(accounts.providerAccountId, input.account.providerAccountId)),
      )
      .limit(1);
    if (linked) return null;

    const [claimed] = await tx
      .update(users)
      .set({
        firstSignedInAt: sql`now()`,
        emailVerified: sql`now()`,
        // What the provider knows about them, where the row says nothing yet.
        name: sql`coalesce(${users.name}, ${input.name ?? null})`,
        image: sql`coalesce(${users.image}, ${input.image ?? null})`,
      })
      .where(
        and(
          sql`lower(${users.email}) = ${email}`,
          isNull(users.firstSignedInAt),
          eq(users.status, "active"),
          isNull(users.externalAccountId),
        ),
      )
      .returning({ id: users.id });
    if (!claimed) return null;

    await tx.insert(accounts).values({
      userId: claimed.id,
      type: input.account.type as (typeof accounts.$inferInsert)["type"],
      provider: input.account.provider,
      providerAccountId: input.account.providerAccountId,
      refresh_token: input.account.refresh_token ?? null,
      access_token: input.account.access_token ?? null,
      expires_at: input.account.expires_at ?? null,
      token_type: input.account.token_type ?? null,
      scope: input.account.scope ?? null,
      id_token: input.account.id_token ?? null,
      session_state: typeof input.account.session_state === "string" ? input.account.session_state : null,
    });
    logger.info("an added user signed in for the first time", { userId: claimed.id, provider: input.account.provider });
    return claimed.id;
  });
}
