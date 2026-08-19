// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Okta from "next-auth/providers/okta";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db, users, accounts, sessions, verificationTokens } from "@/db";
import { admitNewUser } from "@/lib/admission";
import { isProviderReady, warnAuthConfig } from "@/lib/auth-providers";
import { configuredOrigin } from "@/lib/oauth/base-url";
import { hostedIntegration } from "@/lib/hosted-auth-integration";
import { APP_SESSION_MAX_AGE_SECONDS } from "@/lib/app-session";

// A managed deployment's sign-in is owned by an integration (src/lib/hosted-auth.ts); an
// ordinary install is untouched below this line. One session system either way: the
// integration contributes a provider inside NextAuth, never a parallel session beside it.
const hosted = hostedIntegration();

// Log which providers are enabled, and name the missing env var for any that
// are half-configured, so a misconfiguration is obvious in the server logs
// instead of surfacing as a cryptic OAuth error. Runs once per runtime. Skipped
// where an integration owns sign-in, since its providers do not come from these vars —
// the "no providers configured" warning would be describing a healthy deployment.
if (!hosted) warnAuthConfig();

// next-auth's setEnvDefaults reads AUTH_<PROVIDER>_ISSUER straight from the
// environment and assigns it with `finalProvider.issuer ?? (= env)`. A
// present-but-empty issuer var therefore becomes a top-level `issuer: ""`,
// which fails Auth.js's endpoint assertion (`"" ?? default` keeps "") and
// invalidates the ENTIRE sign-in config — not just this provider. Normalize
// empty issuer vars to unset so the provider falls back to its default
// authority (Microsoft → "common"). See docs/authentication.md.
for (const k of ["AUTH_MICROSOFT_ENTRA_ID_ISSUER", "AUTH_OKTA_ISSUER"]) {
  if (process.env[k] !== undefined && process.env[k]!.trim() === "") delete process.env[k];
}

// Pin Auth.js to the configured public URL instead of letting it read the
// origin off request headers.
//
// Without AUTH_URL, Auth.js infers its own URL from the request — and behind a
// proxy that terminates TLS elsewhere it can infer the process's BIND ADDRESS.
// Observed on a hosted instance as a stored callback URL of
// `https://0.0.0.0:3000`. Any flow falling back to a default redirect then aims
// at that.
//
// `AUTH_URL` is the ONLY lever for this. `trustHost` is not one: in Auth.js v5
// it is a hard on/off gate — `assertConfig` returns `UntrustedHost` for EVERY
// request when it is falsy (@auth/core/lib/utils/assert.js), so turning it off
// behind a proxy doesn't pin the origin, it takes sign-in offline. With
// `AUTH_URL` set, next-auth's `reqWithEnvURL` rewrites each request's origin to
// it and `createActionURL` builds from it, so `X-Forwarded-Host` stops
// participating — which is the actual goal, and it holds with `trustHost: true`
// still in place.
//
// The value comes from `configuredOrigin()`, NOT `env.APP_BASE_URL`: that getter
// defaults to `http://localhost:3000`, so reading it here would pin AUTH_URL to
// localhost on every deployment that hasn't set the variable — breaking sign-in
// on exactly the instances the default was meant to help.
//
// Skipped on Vercel PREVIEW deploys. Adding an env var in the Vercel dashboard
// applies it to every environment by default, so an operator who sets
// APP_BASE_URL to their production URL would otherwise find preview sign-in
// bouncing them to production. Previews keep deriving from the request host, as
// before — safe there because Vercel's edge overwrites X-Forwarded-*.
//
// Only fills in a default; an explicitly configured AUTH_URL/NEXTAUTH_URL wins.
const configuredBaseUrl = configuredOrigin();
const isVercelPreview = process.env.VERCEL_ENV === "preview";
if (configuredBaseUrl && !isVercelPreview && !process.env.AUTH_URL && !process.env.NEXTAUTH_URL) {
  process.env.AUTH_URL = configuredBaseUrl;
}

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
  providers: hosted ? hosted.providers() : [
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
        // Empty values are normalized to unset above; unset falls back to the
        // "common" authority (any Microsoft account).
        issuer: process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER,
      }),
    ] : []),
  ],
  // A contributed provider runs JWT sessions: Auth.js refuses database sessions when the
  // only provider is a credentials provider. When the hour lapses, proxy.ts first renews
  // server-side from a fresh integration JWT; /reauth is the browser fallback when the
  // provider SDK must refresh it. Someone revoked there fails both paths.
  //
  // **The hour is an idle timeout, not a cap on a working session.** Auth.js re-signs the
  // token on every session read and `proxy.ts` — wrapped in `auth()` — carries the refreshed
  // cookie onto the response, so each request pushes the expiry an hour out from now. It was
  // an absolute hour for as long as the proxy called a bare `auth()` and dropped that cookie,
  // which signed people out mid-task.
  //
  // Roster-driven deactivation is immediate: it mirrors into users.status, which every
  // authorized request re-reads. The hour still bounds a provider-only revocation that
  // bypasses that mirror.
  session: hosted
    ? { strategy: "jwt", maxAge: APP_SESSION_MAX_AGE_SECONDS }
    : { strategy: "database" },
  // NextAuth's own screens have no providers configured when an integration owns sign-in;
  // everything that would send someone there sends them to its screen instead.
  ...(hosted ? { pages: { signIn: "/login" } } : {}),
  // Required, not optional: Auth.js rejects every request when this is falsy
  // (see the AUTH_URL note above). It lets Auth.js accept the proxied request;
  // it is AUTH_URL — set from APP_BASE_URL above — that decides which origin
  // gets baked into redirects. With APP_BASE_URL unset (local dev, dynamic
  // preview hostnames) the request host is used, as before.
  trustHost: true,
  callbacks: {
    // With JWT sessions there is no adapter user on the session object, so the id has to
    // travel through the token. `token.sub` is the authorize() user's id. The database
    // path keeps its existing behavior untouched.
    async session({ session, token, user }) {
      if (user?.id) session.user.id = user.id;
      else if (token?.sub) session.user.id = token.sub;
      return session;
    },
    // No signIn callback: authentication always succeeds, and authorization is
    // answered per-request from the users row (src/lib/authorize.ts). The
    // EMAIL_ALLOW_LIST check that used to live here was retired when membership
    // moved into the database — an env-var list keyed on email refused exactly
    // the sessions that carry no address, and revoking anyone meant a redeploy.
  },
  events: {
    // First sign-in: decide membership. Auth.js awaits this event before the
    // session exists, so the admission decision (owner bootstrap / invitation /
    // policy) lands before the first authorized request reads the row.
    async createUser({ user }) {
      if (!user.id) return;
      await admitNewUser(user.id, user.email);
    },
  },
});
