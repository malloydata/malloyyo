// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Single source of truth for the sign-in providers and the env vars each one
// needs. src/auth.ts registers a provider only when it's *ready* (all required
// vars set), and the landing page advertises the same ready set — so a sign-in
// button never points at a provider that would fail at the identity provider.
// Partial configuration (some but not all vars) is reported by warnAuthConfig()
// so operators get an exact pointer instead of a cryptic OAuth error.

export type AuthProviderInfo = { id: string; name: string };

type ProviderSpec = {
  // Auth.js provider id — used for the callback route and signIn(id).
  id: string;
  // Display name shown on the sign-in button.
  name: string;
  // Env vars that must all be set for the provider to actually work.
  required: readonly string[];
};

// Order here is the order buttons appear in.
const PROVIDERS: readonly ProviderSpec[] = [
  { id: "google", name: "Google", required: ["AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET"] },
  {
    id: "okta",
    name: "Okta",
    required: ["AUTH_OKTA_CLIENT_ID", "AUTH_OKTA_CLIENT_SECRET", "AUTH_OKTA_ISSUER"],
  },
  {
    id: "microsoft-entra-id",
    name: "Microsoft",
    // AUTH_MICROSOFT_ENTRA_ID_ISSUER is optional (defaults to the "common"
    // authority), so it is not required here.
    required: ["AUTH_MICROSOFT_ENTRA_ID_ID", "AUTH_MICROSOFT_ENTRA_ID_SECRET"],
  },
];

const isSet = (v: string | undefined): boolean => !!v && v.trim() !== "";

export type ProviderStatus = {
  id: string;
  name: string;
  ready: boolean; // all required vars set — safe to advertise and register
  started: boolean; // at least one required var set — operator intended to use it
  missing: string[]; // required vars still unset
};

export function providerStatuses(): ProviderStatus[] {
  return PROVIDERS.map((p) => {
    const missing = p.required.filter((k) => !isSet(process.env[k]));
    return {
      id: p.id,
      name: p.name,
      ready: missing.length === 0,
      started: missing.length < p.required.length,
      missing,
    };
  });
}

// Is this provider id fully configured? src/auth.ts gates registration on this.
export function isProviderReady(id: string): boolean {
  return providerStatuses().some((p) => p.id === id && p.ready);
}

// The ready providers, in display order — advertised to the sign-in UI.
export function configuredAuthProviders(): AuthProviderInfo[] {
  return providerStatuses()
    .filter((p) => p.ready)
    .map(({ id, name }) => ({ id, name }));
}

// Providers the operator started configuring but left incomplete.
export function partialAuthProviders(): ProviderStatus[] {
  return providerStatuses().filter((p) => p.started && !p.ready);
}

let warned = false;

// Logged once per server process (from src/auth.ts). Names exactly which env
// var is missing for any half-configured provider, and confirms which are live.
export function warnAuthConfig(): void {
  if (warned) return;
  warned = true;
  const statuses = providerStatuses();
  const ready = statuses.filter((p) => p.ready);
  for (const p of statuses.filter((p) => p.started && !p.ready)) {
    console.warn(
      `[auth] ${p.name} sign-in is disabled — set the missing env var(s): ${p.missing.join(", ")}. See docs/authentication.md.`,
    );
  }
  if (ready.length === 0) {
    console.warn(
      "[auth] No sign-in providers are configured — sign-in is disabled. See docs/authentication.md.",
    );
  } else {
    console.info(`[auth] Sign-in enabled: ${ready.map((p) => p.name).join(", ")}.`);
  }
}
