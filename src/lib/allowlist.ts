// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The ONE allow-list check, shared by the NextAuth signIn callback, web
// sessions, and MCP token authorization — a divergence here means "signed in
// but denied" (or the reverse), so keep it single-sourced.
// Fail-open by design: an unset EMAIL_ALLOW_LIST allows any authenticated user.
// Entries beginning with "@" are domain rules: "@example.com" admits every
// account on that domain (exact entries still work beside them).
export function isEmailAllowed(email: string | null | undefined): boolean {
  const allowList = process.env.EMAIL_ALLOW_LIST;
  if (!allowList) return true;
  const allowed = allowList.split(",").map((e) => e.trim().toLowerCase());
  const em = (email ?? "").toLowerCase();
  return allowed.some((a) => (a.startsWith("@") ? em.endsWith(a) : em === a));
}
