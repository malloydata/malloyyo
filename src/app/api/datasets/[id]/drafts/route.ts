// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/bearer-auth";
import { originFromRequest } from "@/lib/oauth/base-url";
import { listDrafts, saveDraftDashboard } from "@/lib/dashboards/draft";

export const runtime = "nodejs";

/**
 * POST /api/datasets/:ref/drafts — save a draft dashboard.
 * Body: { name, malloy?, source?, title?, description?, slug? }.
 *
 * The `mcp` scope, not `publish`: a draft dashboard is a query-level act —
 * any member who can query the dataset may make one, and its .malloy passes
 * the same restricted gate a query does (src/lib/dashboards/draft.ts).
 * Nothing about the dataset or its published model changes.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireBearer(req, { scope: "mcp" });
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  let body: {
    name?: unknown;
    malloy?: unknown;
    source?: unknown;
    title?: unknown;
    description?: unknown;
    slug?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const { id } = await ctx.params;
  const result = await saveDraftDashboard(
    auth.user.id,
    id,
    {
      name: String(body.name ?? ""),
      malloy: typeof body.malloy === "string" ? body.malloy : undefined,
      source: typeof body.source === "string" ? body.source : undefined,
      title: typeof body.title === "string" && body.title ? body.title : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      slug: typeof body.slug === "string" && body.slug ? body.slug : undefined,
    },
    originFromRequest(req),
  );
  return NextResponse.json(result, { status: result.ok ? 200 : 422 });
}

/** GET /api/datasets/:ref/drafts — this user's drafts on the dataset, for
    `malloyyo draft list` (and so promotion can find a slug). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireBearer(req, { scope: "mcp" });
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const { id } = await ctx.params;
  return NextResponse.json({ ok: true, drafts: await listDrafts(auth.user.id, id) });
}
