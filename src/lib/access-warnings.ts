// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Startup warnings about who may use this instance, emitted once from
// instrumentation.ts (nodejs runtime only — these read the database, which is
// exactly why they cannot live in src/lib/auth-providers.ts beside the
// provider warnings: that module is compiled into the edge middleware).
//
// Two warnings:
//
// 1. EMAIL_ALLOW_LIST is set. The variable is retired — membership lives in
//    the `users` table — so an operator who edits it and redeploys changes
//    nothing, silently, and that silence reads as a bug in sign-in. Say so
//    loudly, and say exactly where the variable and the database disagree.
// 2. The access policy is `open` while sign-in is enabled. With a public
//    identity provider that means any account on earth. A defensible choice
//    made on purpose and a silent disaster made by omission; the log line is
//    what makes it the former.

// The database (and anything that pulls it in) is imported dynamically inside
// logAccessWarnings: the pure functions here are pinned by the unit suite,
// which runs with no DATABASE_URL, and @/db initializes its client on import.
import { isNull } from "drizzle-orm";
import { configuredAuthProviders } from "./auth-providers";
import { hostedSignIn } from "./hosted-auth-integration";

export function parseRetiredAllowList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * The retired-variable warning, pure over its inputs so it can be pinned in
 * the unit suite. `null` when the variable is unset.
 */
export function retiredAllowListWarning(
  rawList: string | undefined,
  dbState: { activeEmails: string[]; openInvitationEmails: string[] },
): string | null {
  const listed = parseRetiredAllowList(rawList);
  if (rawList === undefined || rawList.trim() === "") return null;

  const active = new Set(dbState.activeEmails.map((e) => e.toLowerCase()));
  const invited = new Set(dbState.openInvitationEmails.map((e) => e.toLowerCase()));

  const listedButNotAdmitted = listed.filter((e) => !active.has(e) && !invited.has(e));
  const activeButNotListed = dbState.activeEmails
    .map((e) => e.toLowerCase())
    .filter((e) => !listed.includes(e));

  let msg =
    "[access] EMAIL_ALLOW_LIST is set but NO LONGER READ — membership now lives in the " +
    "database (admin → Users). Editing the variable changes nothing; remove it to silence " +
    "this warning. The emergency door is BREAK_GLASS_EMAIL. See docs/authentication.md.";
  if (listedButNotAdmitted.length > 0) {
    msg +=
      ` It disagrees with the database: ${listedButNotAdmitted.join(", ")} ` +
      `${listedButNotAdmitted.length === 1 ? "is" : "are"} on the list but not an active ` +
      "user or open invitation — if they should have access, invite or approve them in the UI.";
  }
  if (activeButNotListed.length > 0) {
    msg +=
      ` Active users not on the list: ${activeButNotListed.join(", ")} — the list is not ` +
      "excluding them; disable them in the UI if they should not have access.";
  }
  return msg;
}

/** Read the database and log both warnings as warranted. Best-effort by the caller. */
export async function logAccessWarnings(): Promise<void> {
  // Where an integration owns sign-in, membership is the provider's and the
  // policy/list vocabulary doesn't apply — but a leftover EMAIL_ALLOW_LIST is
  // still worth one line, since on such a deployment it USED to lock out the
  // provider's own SSO members.
  if (hostedSignIn()) {
    if (process.env.EMAIL_ALLOW_LIST?.trim()) {
      console.warn(
        "[access] EMAIL_ALLOW_LIST is set but not read on this deployment — membership is " +
          "the identity provider's. Remove the variable.",
      );
    }
    return;
  }

  const [{ db, invitations, users }, { getAccessPolicy }] = await Promise.all([
    import("@/db"),
    import("./access-policy"),
  ]);

  if (process.env.EMAIL_ALLOW_LIST?.trim()) {
    const activeRows = await db.select({ email: users.email, status: users.status }).from(users);
    const openInvites = await db
      .select({ email: invitations.email })
      .from(invitations)
      .where(isNull(invitations.acceptedAt));
    const warning = retiredAllowListWarning(process.env.EMAIL_ALLOW_LIST, {
      activeEmails: activeRows
        .filter((r) => r.status === "active" && r.email)
        .map((r) => r.email as string),
      openInvitationEmails: openInvites.map((r) => r.email),
    });
    if (warning) console.warn(warning);
  }

  const policy = await getAccessPolicy();
  const providers = configuredAuthProviders();
  if (policy === "open" && providers.length > 0) {
    console.warn(
      `[access] This instance's access policy is 'open' — ANY account that can sign in with ` +
        `${providers.map((p) => p.name).join("/")} becomes an active member, which is every ` +
        `account on that provider unless the provider itself is restricted. Switch the policy ` +
        `to 'invite' in admin settings to require approval.`,
    );
  }
}
