// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, datasets } from "@/db";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { isAdmin } from "@/lib/admin";
import { refreshRepo } from "@/lib/github-refresh";
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

  // The repo is the unit, so a manual refresh refreshes the repo this dataset
  // belongs to — its siblings share a commit and, often, a `lib/`.
  const repo = await refreshRepo(ds.githubRepo, ds.githubBranch ?? "main");
  if ("error" in repo) {
    return NextResponse.json({ ok: false, error: repo.error }, { status: 400 });
  }
  if (repo.failed.length > 0) {
    // Nothing was written — for any dataset in the repo. Say which one is at
    // fault, since the person who pressed the button may not own it.
    return NextResponse.json(
      {
        ok: false,
        error:
          repo.failed.length === 1 && repo.failed[0].id === id
            ? repo.failed[0].error
            : `nothing was refreshed — ${repo.failed.map((f) => `${f.name}: ${f.error}`).join("; ")}`,
        failed: repo.failed,
      },
      { status: 400 },
    );
  }
  const mine = repo.refreshed.find((r) => r.id === id);
  void captureTelemetry(
    {
      event: "model published",
      properties: {
        method: "github_refresh",
        outcome: "success",
        created_dataset: false,
        source_count: 0,
        file_count: 0,
        dashboard_count: 0,
      },
    },
    me.id,
  );
  // The repo's answer, not just this dataset's: the caller pressed refresh on one
  // dataset and moved all of them, and `unpublished` is how they learn a
  // directory is gone without anything having been deleted.
  return NextResponse.json({
    ok: true,
    model: { version: mine?.version ?? null },
    repo: {
      sha: repo.sha,
      refreshed: repo.refreshed,
      unpublished: repo.unpublished,
      unclaimed: repo.unclaimed,
    },
  });
}
