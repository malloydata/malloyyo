// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Where an authentication integration is constructed, and the only file that would name
// one. See ./hosted-auth.ts for the contract and why it is shaped this way.
//
// **In this repository nothing is installed, and this file is the whole implementation.**
// A build that includes an integration replaces this module with one that imports the
// package, builds its `HostedAuthDeps` out of this application's own modules, and returns
// the result. That is the entire substitution: one file, on both sides of a typed contract.
//
// Split from ./hosted-auth because constructing an integration means handing it a
// database-backed capability, and that module is imported on every request by code
// deliberately kept free of the database. Only the route shells and src/auth.ts import
// this one, and they reach the database anyway.

import type { HostedAuthIntegration } from "./hosted-auth";

/**
 * The installed integration, or null when sign-in is the application's own.
 *
 * Always null here, so the route shells answer 404 and src/auth.ts registers the
 * configured OAuth providers. Callers must handle null — a deployment with no integration
 * is the ordinary case, not an error.
 */
export function hostedIntegration(): HostedAuthIntegration | null {
  return null;
}

/**
 * Is sign-in owned by an integration?
 *
 * Derived from `hostedIntegration()` rather than answered separately, and in this module
 * rather than beside the types, because this is the file a hosted build replaces. The two
 * used to live apart — the cheap question in ./hosted-auth so that callers who must not
 * reach the database could ask it — and a hosted build substituted only this one, leaving
 * the other insisting no integration existed while one was serving sign-in. Whatever this
 * costs a caller, it cannot disagree with itself.
 */
export function hostedSignIn(): boolean {
  return hostedIntegration() !== null;
}
