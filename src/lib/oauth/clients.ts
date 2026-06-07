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
