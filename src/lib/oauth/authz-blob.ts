// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { signBlob, verifyBlob } from "./signed-blob";

export interface PendingAuthz {
  // The user who initiated this authorization at /authorize. Binding it here
  // (and enforcing it in the consent /decide step) makes the consent decision
  // usable only by the same session that started the flow — so a cross-site
  // POST of a lifted blob can't mint a code against a *different* victim's
  // session. Without this, CSRF protection would rest solely on the session
  // cookie's SameSite=Lax default.
  userId: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  resource: string | null;
  state: string | null;
  exp: number;
}

export function signAuthz(payload: Omit<PendingAuthz, "exp">): string {
  return signBlob(payload);
}

export function verifyAuthz(token: string): PendingAuthz | null {
  return verifyBlob<Omit<PendingAuthz, "exp">>(token);
}
