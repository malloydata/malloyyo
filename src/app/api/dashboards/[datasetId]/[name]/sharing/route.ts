// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Who sees one dashboard, and changing it. A thin shell: the rules are in
// src/lib/dashboards/sharing.ts (who may change what) and ./audience (who may
// see what).
//
//   GET     the current audience
//   PATCH   { visibility }  general access: private, or open to the dataset
//   POST    { email }       share it with one person
//   DELETE  { userId }      stop sharing it with them
//
// A browser session only. This is something a person does on a dashboard's
// page; nothing unattended has a reason to re-audience a dashboard.

import { NextResponse } from "next/server";
import { DRAFT_VISIBILITIES, type DraftVisibility, type User } from "@/db";
import { getSessionUserOrNull } from "@/lib/user";
import {
  getSharing,
  setDashboardVisibility,
  shareDashboard,
  unshareDashboard,
  type SharingResult,
} from "@/lib/dashboards/sharing";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ datasetId: string; name: string }> };

function answer<T>(r: SharingResult<T>) {
  return r.ok
    ? NextResponse.json({ ok: true, sharing: r.value })
    : NextResponse.json({ ok: false, error: r.error }, { status: r.status });
}

async function withUser(
  ctx: Ctx,
  fn: (user: User, datasetId: string, name: string) => Promise<NextResponse>,
): Promise<NextResponse> {
  const user = await getSessionUserOrNull();
  if (!user) return NextResponse.json({ ok: false, error: "sign in first" }, { status: 401 });
  const { datasetId, name } = await ctx.params;
  return fn(user, datasetId, name);
}

async function bodyOf(req: Request): Promise<Record<string, unknown>> {
  const body = (await req.json().catch(() => null)) as unknown;
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

export async function GET(_req: Request, ctx: Ctx) {
  return withUser(ctx, async (user, datasetId, name) => answer(await getSharing(user, datasetId, name)));
}

export async function PATCH(req: Request, ctx: Ctx) {
  const { visibility } = await bodyOf(req);
  if (!(DRAFT_VISIBILITIES as readonly unknown[]).includes(visibility)) {
    return NextResponse.json(
      { ok: false, error: `visibility must be one of: ${DRAFT_VISIBILITIES.join(", ")}` },
      { status: 400 },
    );
  }
  return withUser(ctx, async (user, datasetId, name) =>
    answer(await setDashboardVisibility(user, datasetId, name, visibility as DraftVisibility)),
  );
}

export async function POST(req: Request, ctx: Ctx) {
  const { email } = await bodyOf(req);
  if (typeof email !== "string" || !email.trim()) {
    return NextResponse.json({ ok: false, error: "an email address is required" }, { status: 400 });
  }
  return withUser(ctx, async (user, datasetId, name) => answer(await shareDashboard(user, datasetId, name, email)));
}

export async function DELETE(req: Request, ctx: Ctx) {
  const { userId } = await bodyOf(req);
  // Shape-checked here because it goes straight into a uuid comparison, where
  // anything else is a database error rather than "nobody by that id".
  if (typeof userId !== "string" || !UUID_RE.test(userId)) {
    return NextResponse.json({ ok: false, error: "userId is required" }, { status: 400 });
  }
  return withUser(ctx, async (user, datasetId, name) => answer(await unshareDashboard(user, datasetId, name, userId)));
}
