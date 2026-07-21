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
import { isProviderReady, warnAuthConfig } from "@/lib/auth-providers";

// Log which providers are enabled, and name the missing env var for any that
// are half-configured, so a misconfiguration is obvious in the server logs
// instead of surfacing as a cryptic OAuth error. Runs once per process.
warnAuthConfig();

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  // Every provider is opt-in and registered only when it's fully configured —
  // isProviderReady() (src/lib/auth-providers.ts) is the single source of truth
  // for the required env vars, shared with the sign-in UI so a button never
  // points at a provider that would fail. Configure any subset; if none are
  // ready, sign-in is disabled. See docs/authentication.md.
  providers: [
    ...(isProviderReady("google") ? [
      Google({
        clientId: process.env.AUTH_GOOGLE_ID,
        clientSecret: process.env.AUTH_GOOGLE_SECRET,
      }),
    ] : []),
    ...(isProviderReady("okta") ? [
      Okta({
        clientId: process.env.AUTH_OKTA_CLIENT_ID,
        clientSecret: process.env.AUTH_OKTA_CLIENT_SECRET,
        issuer: process.env.AUTH_OKTA_ISSUER,
      }),
    ] : []),
    // Omit AUTH_MICROSOFT_ENTRA_ID_ISSUER to allow any Microsoft account (the
    // "common" authority); set it to https://login.microsoftonline.com/<tenant>/v2.0/
    // to restrict sign-in to a single organization. See docs/authentication.md.
    ...(isProviderReady("microsoft-entra-id") ? [
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
