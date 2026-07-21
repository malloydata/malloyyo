// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Okta from "next-auth/providers/okta";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { db, users, accounts, sessions, verificationTokens } from "@/db";
import { newUserSlug } from "@/lib/slug";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  // Every provider is opt-in via its own env vars — configure any subset. If
  // none are set, sign-in is disabled entirely. See docs/authentication.md.
  providers: [
    ...(process.env.AUTH_GOOGLE_ID ? [
      Google({
        clientId: process.env.AUTH_GOOGLE_ID,
        clientSecret: process.env.AUTH_GOOGLE_SECRET,
      }),
    ] : []),
    ...(process.env.AUTH_OKTA_CLIENT_ID ? [
      Okta({
        clientId: process.env.AUTH_OKTA_CLIENT_ID,
        clientSecret: process.env.AUTH_OKTA_CLIENT_SECRET,
        issuer: process.env.AUTH_OKTA_ISSUER,
      }),
    ] : []),
    // Microsoft Entra ID (Azure AD) — optional, enabled when the client ID is set.
    // Omit AUTH_MICROSOFT_ENTRA_ID_ISSUER to allow any Microsoft account (the
    // "common" tenant); set it to https://login.microsoftonline.com/<tenant>/v2.0/
    // to restrict sign-in to a single organization. See docs/authentication.md.
    ...(process.env.AUTH_MICROSOFT_ENTRA_ID_ID ? [
      MicrosoftEntraID({
        clientId: process.env.AUTH_MICROSOFT_ENTRA_ID_ID,
        clientSecret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
        issuer: process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER,
      }),
    ] : []),
  ],
  session: { strategy: "database" },
  // Vercel preview deploys use dynamic hostnames; trust the request host.
  trustHost: true,
  callbacks: {
    async signIn({ user }) {
      const allowList = process.env.EMAIL_ALLOW_LIST;
      if (!allowList) return true;
      const allowed = allowList.split(",").map((e) => e.trim().toLowerCase());
      return allowed.includes((user.email ?? "").toLowerCase());
    },
  },
  events: {
    // Assign a friendly slug on first sign-in. Retry on the rare
    // unique-constraint collision (~525k namespace).
    async createUser({ user }) {
      if (!user.id) return;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await db
            .update(users)
            .set({ slug: newUserSlug() })
            .where(eq(users.id, user.id));
          return;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!/users_slug_unique|duplicate key/i.test(msg) || attempt === 4) {
            throw err;
          }
        }
      }
    },
  },
});
