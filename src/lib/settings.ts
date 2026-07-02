// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { db, instanceSettings } from "@/db";
import { eq } from "drizzle-orm";
import { env } from "./env";

// Editable, per-instance presentation copy. Stored in one row keyed by
// INSTANCE_CODE; an empty/absent value falls back to the built-in default.

// Front-page tagline, shown under the instance title.
export const DEFAULT_TAGLINE =
  "Ask analytical questions of this data in plain language. Connect from " +
  "claude.ai (or any MCP client) and explore trusted Malloy semantic models — " +
  "run queries, break down metrics, and share the results as links.";

// Privacy note shown next to the sign-in button.
export const DEFAULT_SIGNIN_NOTICE =
  "We only are collecting your name, email and icon. We won't send you anything.";

export type InstanceSettingsView = { tagline: string; signinNotice: string };

// Which editable fields exist, with their DB column and default. Adding a new
// message means adding one entry here plus rendering it.
export const SETTING_DEFAULTS: Record<keyof InstanceSettingsView, string> = {
  tagline: DEFAULT_TAGLINE,
  signinNotice: DEFAULT_SIGNIN_NOTICE,
};

function nonEmpty(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t && t.length > 0 ? t : null;
}

export async function getSettings(): Promise<InstanceSettingsView> {
  const [row] = await db
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.instanceCode, env.INSTANCE_CODE))
    .limit(1);
  return {
    tagline: nonEmpty(row?.tagline) ?? DEFAULT_TAGLINE,
    signinNotice: nonEmpty(row?.signinNotice) ?? DEFAULT_SIGNIN_NOTICE,
  };
}

// Upsert only the provided fields. An empty string clears the override (stored
// as null) so the field falls back to its default.
export async function updateSettings(patch: Partial<InstanceSettingsView>): Promise<void> {
  const set: Record<string, string | null | Date> = { updatedAt: new Date() };
  if ("tagline" in patch) set.tagline = nonEmpty(patch.tagline);
  if ("signinNotice" in patch) set.signinNotice = nonEmpty(patch.signinNotice);
  await db
    .insert(instanceSettings)
    .values({
      instanceCode: env.INSTANCE_CODE,
      tagline: "tagline" in patch ? nonEmpty(patch.tagline) : null,
      signinNotice: "signinNotice" in patch ? nonEmpty(patch.signinNotice) : null,
    })
    .onConflictDoUpdate({ target: instanceSettings.instanceCode, set });
}
