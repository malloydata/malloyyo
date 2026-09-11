// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// CSRF protection for the device-flow approval step, following the same reasoning
// authz-blob.ts records for the authorization-code consent step.
//
// Why the device flow needs this MORE, not less. /api/oauth/device/decide is a
// cookie-authed POST, and the only other value in the request is the user_code —
// which the attacker KNOWS, because they started the flow. So without a token
// bound to the approving session, the sole barrier between an attacker and a
// token scoped to a victim is the session cookie's SameSite=Lax default, and
// authz-blob.ts already concluded that resting on it alone is not good enough.
//
// The elaborate "type the code yourself" defense on the approval page is worth
// nothing against a cross-site POST that skips the page entirely. This is what
// makes that defense real.
//
// Bound to the userId, and enforced on decide, so a blob lifted from one session
// cannot be replayed to approve something as a different user.

import { signBlob, verifyBlob } from "./signed-blob";

export interface DeviceApproval {
  /** The session this approval form was rendered for. */
  userId: string;
  exp: number;
}

/** The blob's TTL (signed-blob.ts) matches the device code's own lifetime: a
    form that outlived its code would only produce a confusing "not found". */
export function signDeviceApproval(userId: string): string {
  return signBlob({ userId });
}

export function verifyDeviceApproval(token: string): DeviceApproval | null {
  const parsed = verifyBlob<{ userId?: unknown }>(token);
  if (!parsed) return null;
  if (typeof parsed.userId !== "string" || !parsed.userId) return null;
  return { userId: parsed.userId, exp: parsed.exp };
}
