// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Where sign-in and sign-out live, decided in exactly one place.
//
// The default deployment uses NextAuth's own screens. A deployment whose sign-in is owned
// by an integration has its own pages — and for that deployment NextAuth's endpoints are
// dead ends: its sign-in screen has no providers configured, and its sign-out clears no
// cookie the integration's session holds. Deriving this anywhere else is how the header's
// sign-out once pointed at the wrong system precisely when somebody had a session to end.

import { hostedSignIn } from "./hosted-auth-integration";
import { safeCallbackUrl } from "./callback-url";

export { safeCallbackUrl };

export function signInPath(callbackUrl: string): string {
  const base = hostedSignIn() ? "/login" : "/api/auth/signin";
  return `${base}?callbackUrl=${encodeURIComponent(safeCallbackUrl(callbackUrl))}`;
}

export function signOutPath(callbackUrl: string): string {
  const base = hostedSignIn() ? "/logout" : "/api/auth/signout";
  return `${base}?callbackUrl=${encodeURIComponent(safeCallbackUrl(callbackUrl))}`;
}
