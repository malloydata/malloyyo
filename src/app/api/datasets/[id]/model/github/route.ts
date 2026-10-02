// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * `POST /api/datasets/:id/model/github` — pull this dataset's repo again.
 *
 * The REPO is the unit, so pressing refresh on one dataset moves all of them:
 * its siblings share a commit and, often, a `lib/`. The dataset in the URL is
 * how the UI addresses it and nothing more — which repo to pull is now a foreign
 * key rather than a pair of text columns on this row.
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, datasets } from "@/db";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { isAdmin } from "@/lib/admin";
import { refreshRepo } from "@/lib/github-refresh";
import { repoById } from "@/lib/repos";
import { captureTelemetry } from "@/lib/telemetry";

export const runtime = "nodejs";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let me;
  try {
    me = await getSessionUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "sign in required" }, { status: 401 });
    throw err;
  }
  if (!isAdmin(me)) return NextResponse.json({ error: "admin required" }, { status: 403 });

  const { id } = await ctx.params;
  const [ds] = await db.select().from(datasets).where(eq(datasets.id, id));
  if (!ds) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!ds.repoId) {
    return NextResponse.json({ error: "this dataset is not published by a repo" }, { status: 400 });
  }
  const repo = await repoById(ds.repoId);
  if (!repo) return NextResponse.json({ error: "this dataset's repo is gone" }, { status: 404 });
  if (!repo.githubRepo) {
    return NextResponse.json(
      { error: `the repo "${repo.slug}" is not attached to GitHub, so there is nothing to pull` },
      { status: 400 },
    );
  }

  const result = await refreshRepo(repo.id);
  if (!result.ok) {
    void captureTelemetry(
      {
        event: "model published",
        properties: {
          method: "github_refresh",
          outcome: "error",
          created_dataset: false,
          source_count: 0,
          file_count: 0,
          dashboard_count: 0,
        },
      },
      me.id,
    );
    // Nothing was activated — for any dataset in the repo. Say which one is at
    // fault, since the person who pressed the button may not own it.
    const mine = result.failures?.length === 1 && result.failures[0].dir === ds.repoDir;
    return NextResponse.json(
      {
        ok: false,
        error: mine ? result.failures![0].error : result.error,
        ...(result.failures ? { failed: result.failures } : {}),
        ...(result.revisionId ? { revision: result.revisionId } : {}),
      },
      { status: 400 },
    );
  }

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
  const mine = result.datasets.find((d) => d.id === id);
  // The repo's answer, not just this dataset's: the caller pressed refresh on
  // one dataset and moved all of them, and `unpublished` is how they learn a
  // directory is gone without anything having been deleted.
  return NextResponse.json({
    ok: true,
    model: { version: mine?.version ?? null },
    repo: {
      slug: repo.slug,
      revision: result.revision,
      sha: result.sha,
      unchanged: result.unchanged ?? false,
      refreshed: result.datasets,
      unpublished: result.unpublished,
      unclaimed: result.unclaimed,
    },
  });
}
