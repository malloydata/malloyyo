// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, datasets } from "@/db";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { isAdmin } from "@/lib/admin";
import { refreshGitHubModel } from "@/lib/github-refresh";
import { captureTelemetry } from "@/lib/telemetry";

export const runtime = "nodejs";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  let me;
  try { me = await getSessionUser(); } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "sign in required" }, { status: 401 });
    throw err;
  }
  if (!isAdmin(me)) return NextResponse.json({ error: "admin required" }, { status: 403 });

  const { id } = await ctx.params;
  const [ds] = await db.select().from(datasets).where(eq(datasets.id, id));
  if (!ds) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!ds.githubRepo) return NextResponse.json({ error: "dataset has no github_repo configured" }, { status: 400 });

  const result = await refreshGitHubModel(id);
  void captureTelemetry(
    {
      event: "model published",
      properties: {
        method: "github_refresh",
        outcome: result.ok ? "success" : "error",
        created_dataset: false,
        source_count: result.ok ? result.sources.length : 0,
        file_count: result.ok ? result.fileCount : 0,
        dashboard_count: result.ok ? result.dashboardCount : 0,
      },
    },
    me.id,
  );
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true, model: result });
}
