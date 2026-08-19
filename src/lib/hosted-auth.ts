// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Pluggable sign-in: the socket an authentication integration plugs into.
//
// Malloyyo signs people in with the providers configured in src/auth.ts — Google, Okta,
// Microsoft Entra. A deployment can instead be built with an *integration* that owns
// sign-in entirely: it contributes its own Auth.js provider, optional server renewal, and
// supplies the screens mounted at /login, /reauth, /logout, and /authenticate. It may also
// contribute admin pages,
// mounted under /admin/x/ by one catch-all shell and listed as tabs on /admin — an
// open-ended set, so no new page ever needs a new route here.
//
// **This module declares types and nothing else.** It deliberately answers no runtime
// question: an answer here would be compiled in, and a build that installs an integration
// replaces ./hosted-auth-integration rather than this file — so a hard-coded `false` here
// stayed false on a hosted instance while the integration was demonstrably running. That
// shipped, and it is exactly the two-sources-of-truth failure this seam exists to avoid.
// Both `hostedIntegration()` and `hostedSignIn()` therefore live in the module that is
// substituted, and derive from one value.
//
// The contract is deliberately narrow and one-directional. The application hands the
// integration a fixed set of capabilities (`HostedAuthDeps`) and receives a fixed set of
// contributions (`HostedAuthIntegration`) — nothing else crosses. In particular the
// application never learns *how* the integration authenticates: no provider name, no
// tenant model, no notion of an organization. It knows only that something owns sign-in.
//
// This module must stay free of the session machinery and the database. It is imported by
// src/lib/email-allow-list.ts, which is kept free of both so that auth -> user -> auth is
// not an import cycle. It is types and one null.

import type { ComponentType } from "react";
import type { Provider } from "next-auth/providers";

/** The application-owned user shape an integration may resolve after authentication. */
export type HostedUser = {
  id: string;
  email: string | null;
  name: string | null;
  image: string | null;
};

/**
 * What the application lends the integration.
 *
 * An integration is installed into this application and cannot resolve its `@/…` modules,
 * so anything it needs from here is passed in. Keep this list short and boring: every
 * entry is a capability handed to code the application does not own, and the reason to
 * prefer a narrow function over a raw handle is that the narrow one cannot be used for
 * something else later.
 */
export type HostedAuthDeps = {
  /**
   * Find the local user row for someone the integration has authenticated, creating it on
   * first sign-in. Deliberately a function rather than the database handle: the integration
   * never sees the schema, and cannot read or write anything but this.
   *
   * `externalAccountId` is the integration's own stable identifier for the person. It is
   * the key, not the email address — an address may be absent, and may change.
   */
  // A property with a function type, never method syntax. TypeScript checks method
  // parameters *bivariantly*, so `findOrCreateUser(input: …)` would accept an
  // implementation demanding a field this type does not supply — the contract would look
  // pinned and enforce nothing. A function-typed property gets `strictFunctionTypes`.
  findOrCreateUser: (input: {
    externalAccountId: string;
    email: string | null;
    isAdmin: boolean;
  }) => Promise<HostedUser>;
  /**
   * Mirror a revocation (or its reversal) made in the integration's own membership
   * surface onto the local row, so the instance can refuse the very next request
   * instead of waiting out the session token. Keyed on `externalAccountId`, like
   * everything the integration knows about a person; a person with no local row has
   * nothing to mirror and the call is a no-op. Re-enabling only reverses a disable —
   * it never invents an active row.
   *
   * Admin-gated by construction: the integration may call this only from a contributed
   * admin page's `handleAction`, which the application authorizes before delegating.
   */
  setUserDisabled: (input: { externalAccountId: string; disabled: boolean }) => Promise<void>;
  /**
   * The application's own facts about people the integration is listing — read-only,
   * batched, keyed on `externalAccountId`. What the integration's roster shows beside
   * its own columns: whether the local row is disabled, when the person last did
   * anything here, and how many datasets they own. Addresses with no local row
   * (someone invited who never arrived) simply have no entry in the result.
   */
  getUserFacts: (externalAccountIds: string[]) => Promise<
    Array<{
      externalAccountId: string;
      disabled: boolean;
      /** ISO timestamp of the newest history row, or null for "never". */
      lastActiveAt: string | null;
      datasetCount: number;
    }>
  >;
  /** Structured logging, so an integration's diagnostics land where the app's do. */
  logger: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
  };
  /** This instance's public URL. Integrations need absolute redirect targets. */
  appBaseUrl: string;
  /** This instance's display name, for the integration's own screens. */
  instanceName: string;
  /**
   * Read one value from the integration's own settings namespace; `null` means unset.
   *
   * The namespace belongs to the integration alone: the application stores the values —
   * per instance, beside its own `instance_settings` — but never reads them, and none of
   * its own settings live there. A read may happen while rendering for an anonymous
   * visitor (the sign-in screen is a caller), so nothing secret goes in this store.
   */
  readSetting: (key: string) => Promise<string | null>;
  /**
   * Write one value in the same namespace; `null` clears the key, restoring unset.
   *
   * A raw write, like `findOrCreateUser` is a raw create: the application authorizes the
   * administrator at every surface it mounts (the admin page and action shells), and the
   * integration must not call this from any path those gates do not cover.
   */
  writeSetting: (key: string, value: string | null) => Promise<void>;
};

/** Props every mounted screen receives. The shells sanitize `callbackUrl` before it lands here. */
export type HostedScreenProps = {
  /** Where to send the person once sign-in completes. Already validated as same-origin. */
  callbackUrl: string;
};

/** Props the admin-page shell passes to a contributed page. */
export type HostedAdminPageProps = {
  /**
   * This page's own action endpoint (`/api/admin/x/<slug>`), for whatever its client half
   * needs a server for. The application authorizes the administrator before the
   * integration sees a request. Relative, because every caller is same-origin.
   */
  actionUrl: string;
};

/**
 * One contributed admin page: a tab on /admin, a page at /admin/x/<slug>, and optionally
 * a server endpoint behind the same admin gate.
 */
export type HostedAdminPage = {
  /** Path segment under /admin/x/ — lowercase `a-z0-9-`, unique within the integration. */
  slug: string;
  /** The tab label on /admin. */
  label: string;
  /** The page body. A server component that wraps any client half, like the screens. */
  Component: ComponentType<HostedAdminPageProps>;
  /**
   * Handles requests to the page's action endpoint, every method. Absent means the
   * endpoint answers 404, like an unimplemented handoff. Method policy (405s) is the
   * integration's; authorization is the application's, before this is called.
   */
  // A function-typed property, never method syntax — same bivariance reason as
  // findOrCreateUser above.
  handleAction?: (request: Request) => Promise<Response>;
};

/**
 * What the integration contributes.
 *
 * The screens are mounted by route shells this repository owns (`src/app/login` and
 * friends), because Next resolves routes from the filesystem. The shells handle what is
 * the application's business — the existing-session check, callback-URL sanitizing, the
 * page frame — and render these for the part that is not.
 */
export type HostedAuthIntegration = {
  /**
   * Providers registered with NextAuth. These *replace* the built-in providers rather than
   * joining them: a deployment whose sign-in is owned by an integration signs people in one
   * way, and leaving the built-ins registered alongside would offer a second door that the
   * integration's own membership checks never see.
   */
  providers(): Provider[];
  /**
   * Recover an application user from an integration session already present on the
   * request. Optional so self-hosted deployments and integrations without renewal pay
   * nothing. The application mints its own Auth.js token from the returned user.
   */
  // A function-typed property, never method syntax — same strictFunctionTypes reason as
  // the lent capabilities above.
  renewSession?: (request: Request) => Promise<HostedUser | null>;
  /** The sign-in screen, mounted at /login. */
  LoginScreen: ComponentType<HostedScreenProps & { authenticateUrl: string }>;
  /** Silent browser fallback, mounted at /reauth when server renewal is unavailable. */
  RenewScreen: ComponentType<HostedScreenProps>;
  /** Account-recovery, mounted at /login/recover. */
  RecoverScreen: ComponentType<HostedScreenProps>;
  /** The integration's return URL, mounted at /authenticate. */
  AuthenticateScreen: ComponentType<HostedScreenProps>;
  /** Sign-out, mounted at /logout — an integration may hold a session this app cannot clear. */
  SignOutScreen: ComponentType<HostedScreenProps>;
  /**
   * A cross-host sign-in handoff, mounted at /api/auth/handoff.
   *
   * Optional: an integration that admits people only on this host needs none. When absent
   * the route answers 404, so an unimplemented handoff is indistinguishable from a route
   * that was never there.
   */
  handleHandoff?(request: Request): Promise<Response>;
  /**
   * Admin pages, mounted by one catch-all shell at /admin/x/<slug> with a tab per entry
   * on /admin. The set is the integration's to grow — the application's own admin routes
   * live outside /admin/x/, so a contribution can never shadow one, and no future page
   * needs a change here.
   */
  adminPages?: HostedAdminPage[];
};
