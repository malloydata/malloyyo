// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { isAdmin } from "@/lib/admin";
import { getSettings, updateSettings, SETTING_DEFAULTS, type InstanceSettingsView } from "@/lib/settings";

export const runtime = "nodejs";

async function requireAdmin() {
  const me = await getSessionUser();
  if (!isAdmin(me)) throw new UnauthorizedError("not authorized");
  return me;
}

export async function GET() {
  try {
    await requireAdmin();
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: err.message }, { status: 403 });
    throw err;
  }
  return NextResponse.json({ settings: await getSettings(), defaults: SETTING_DEFAULTS });
}

export async function POST(req: Request) {
  try {
    await requireAdmin();
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: err.message }, { status: 403 });
    throw err;
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const patch: Partial<InstanceSettingsView> = {};
  for (const key of Object.keys(SETTING_DEFAULTS) as (keyof InstanceSettingsView)[]) {
    if (key in body) {
      if (typeof body[key] !== "string") {
        return NextResponse.json({ error: `${key} must be a string` }, { status: 400 });
      }
      patch[key] = body[key] as string;
    }
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "no known fields to update" }, { status: 400 });
  }
  await updateSettings(patch);
  return NextResponse.json({ settings: await getSettings() });
}
