// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * `POST /api/repos/:id/refresh` — pull this repo from GitHub again.
 *
 * The same operation the dataset route already performed, addressed by the thing
 * it actually acts on. `/api/datasets/:id/model/github` refreshes the whole repo
 * the dataset belongs to, which is correct behaviour under a URL that describes
 * it wrongly; that route stays for the dataset page, and this is what the repo
 * page calls.
 *
 * It is also how an upgraded instance converts: a repo still served from
 * per-file rows has no revision, so nothing short-circuits and this stores,
 * verifies and activates its first one. Deliberate, never automatic — a
 * conversion replaces what is being served, and that should not ride along on a
 * webhook nobody pressed.
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, repos } from "@/db";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { isAdmin } from "@/lib/admin";
import { refreshRepo } from "@/lib/github-refresh";
import { captureTelemetry } from "@/lib/telemetry";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const [repo] = await db
    .select()
    .from(repos)
    .where(UUID.test(id) ? eq(repos.id, id) : eq(repos.slug, id))
    .limit(1);
  if (!repo) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!repo.githubRepo) {
    return NextResponse.json(
      { error: `"${repo.slug}" is not attached to GitHub, so there is nothing to pull` },
      { status: 400 },
    );
  }

  // `create` adds a dataset for any directory the repo publishes that no dataset
  // covers yet. Off by default, because creating datasets is not what "refresh"
  // means and a webhook must never do it — but reachable, because a repo whose
  // datasets were removed is otherwise inert: a plain refresh only refreshes
  // what already exists, so it would succeed, publish nothing, and report every
  // directory as unclaimed forever.
  const url = new URL(_req.url);
  const createDatasets = url.searchParams.get("create") === "1";

  const result = await refreshRepo(repo.id, { createDatasets });
  void captureTelemetry({
    event: "model published",
    properties: {
      // The same event the dataset route emits: this is the same operation
      // under a URL that names what it acts on. A second label would split one
      // funnel in the analytics for no reason anybody reading them would want.
      method: "github_refresh",
      outcome: result.ok ? "success" : "error",
      created_dataset: createDatasets,
      source_count: 0,
      file_count: 0,
      dashboard_count: 0,
    },
  });

  if (!result.ok) {
    // All-or-nothing, so one dataset's compile error means none of them moved —
    // and the previous revision is still the one being served.
    return NextResponse.json({ error: result.error, kind: result.kind }, { status: 400 });
  }

  return NextResponse.json({
    ok: true,
    unchanged: result.unchanged ?? false,
    // Directories the repo publishes that no dataset covers. Non-empty after a
    // plain refresh is the signal to retry with `create`.
    unclaimed: result.unclaimed?.map((u) => u.dir) ?? [],
    revision: result.revision,
    sha: result.sha,
    datasets: result.datasets.map((d) => d.qualified),
  });
}
