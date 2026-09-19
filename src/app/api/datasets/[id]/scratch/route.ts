// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/bearer-auth";
import { originFromRequest } from "@/lib/oauth/base-url";
import { saveScratchDashboard } from "@/lib/dashboards/scratch";

export const runtime = "nodejs";

/**
 * POST /api/datasets/:ref/scratch — save a scratch dashboard (`malloyyo
 * scratch push`). Body: { name, malloy, source?, slug? }.
 *
 * The `mcp` scope, not `publish`: a scratch dashboard is a query-level act —
 * any member who can query the dataset may make one, and its .malloy passes
 * the same restricted gate a query does (src/lib/dashboards/scratch.ts).
 * Nothing about the dataset or its published model changes.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireBearer(req, { scope: "mcp" });
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  let body: { name?: unknown; malloy?: unknown; source?: unknown; slug?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const { id } = await ctx.params;
  const result = await saveScratchDashboard(
    auth.user.id,
    id,
    {
      name: String(body.name ?? ""),
      malloy: String(body.malloy ?? ""),
      source: typeof body.source === "string" ? body.source : undefined,
      slug: typeof body.slug === "string" && body.slug ? body.slug : undefined,
    },
    originFromRequest(req),
  );
  return NextResponse.json(result, { status: result.ok ? 200 : 422 });
}
