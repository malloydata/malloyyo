// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Which sign-in providers are actually configured in the environment, in the
// order they should appear on the sign-in UI. This mirrors the conditional
// provider registration in src/auth.ts — a provider only works when its
// credentials are present, so we only advertise those. The `id` matches the
// Auth.js provider id used for the callback route and `signIn(id)`.
export type AuthProviderInfo = { id: string; name: string };

export function configuredAuthProviders(): AuthProviderInfo[] {
  const list: AuthProviderInfo[] = [];
  if (process.env.AUTH_GOOGLE_ID) list.push({ id: "google", name: "Google" });
  if (process.env.AUTH_OKTA_CLIENT_ID) list.push({ id: "okta", name: "Okta" });
  if (process.env.AUTH_MICROSOFT_ENTRA_ID_ID)
    list.push({ id: "microsoft-entra-id", name: "Microsoft" });
  return list;
}
