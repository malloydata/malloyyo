// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { db, oauthClients, type OAuthClient } from "@/db";
import { eq } from "drizzle-orm";

export async function getOAuthClient(clientId: string): Promise<OAuthClient | null> {
  const rows = await db.select().from(oauthClients).where(eq(oauthClients.id, clientId)).limit(1);
  return rows[0] ?? null;
}

export function isRegisteredRedirect(client: OAuthClient, redirectUri: string): boolean {
  return client.redirectUris.includes(redirectUri);
}

/** Whether the client registered for this grant (RFC 7591 `grant_types`).

    Every endpoint that starts or completes a grant checks this — /authorize and
    the token endpoint's three handlers, and /device_authorization — because a
    client registers for ONE flow and relies on the others being closed to it. A
    device-flow client must supply a redirect_uri at registration (the metadata
    requires a non-empty list) and expects that placeholder to be inert; it is
    inert only if /authorize refuses a client that never registered for
    `authorization_code`. */
export function clientMayUse(client: OAuthClient, grantType: string): boolean {
  return client.grantTypes.includes(grantType);
}
