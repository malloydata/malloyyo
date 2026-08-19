// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The settings store lent to an authentication integration (src/lib/hosted-auth.ts):
// one key/value namespace per instance, reached through these two functions and nothing
// else. The application's own settings live in src/lib/settings.ts and never here.
//
// This module must stay off the session machinery: a build with an integration imports
// it from src/lib/hosted-auth-integration.ts, which src/auth.ts imports while assembling
// NextAuth — so a dependency on ./user or @/auth here is an import cycle. Authorization
// is therefore the callers' job, and the admin shells gate every path that reaches
// writeIntegrationSetting.

import { db, integrationSettings } from "@/db";
import { and, eq } from "drizzle-orm";
import { env } from "./env";

export async function readIntegrationSetting(key: string): Promise<string | null> {
  const [row] = await db
    .select({ value: integrationSettings.value })
    .from(integrationSettings)
    .where(
      and(eq(integrationSettings.instanceCode, env.INSTANCE_CODE), eq(integrationSettings.key, key)),
    )
    .limit(1);
  return row?.value ?? null;
}

// `null` clears the key: unset is the absence of a row, so defaults stay the
// integration's business instead of becoming stored values.
export async function writeIntegrationSetting(key: string, value: string | null): Promise<void> {
  if (value === null) {
    await db
      .delete(integrationSettings)
      .where(
        and(
          eq(integrationSettings.instanceCode, env.INSTANCE_CODE),
          eq(integrationSettings.key, key),
        ),
      );
    return;
  }
  await db
    .insert(integrationSettings)
    .values({ instanceCode: env.INSTANCE_CODE, key, value })
    .onConflictDoUpdate({
      target: [integrationSettings.instanceCode, integrationSettings.key],
      set: { value, updatedAt: new Date() },
    });
}
