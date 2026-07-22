// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse, after } from "next/server";
import { eq } from "drizzle-orm";
import { db, datasets } from "@/db";
import { refreshGitHubModel } from "@/lib/github-refresh";
import { logger, serializeErr } from "@/lib/logger";

export const runtime = "nodejs";

// Public endpoint — no auth required. The UUID dataset ID is the implicit secret.
// GitHub calls this on push events to automatically refresh the Malloy model.
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const [ds] = await db
    .select({ id: datasets.id, githubRepo: datasets.githubRepo, githubBranch: datasets.githubBranch })
    .from(datasets)
    .where(eq(datasets.id, id));
  if (!ds?.githubRepo) {
    // Return 200 anyway so GitHub doesn't retry endlessly.
    return NextResponse.json({ ok: false, error: "dataset not found or has no github_repo" });
  }

  // GitHub push webhooks fire for EVERY branch. Refresh only on pushes to the
  // dataset's configured branch — in an active repo, anything else would mint
  // a redundant model version per feature-branch push. Payload-less calls
  // (curl, manual triggers) have no `ref` and always refresh.
  try {
    const body = (await req.json()) as { ref?: unknown };
    if (typeof body?.ref === "string" && body.ref !== `refs/heads/${ds.githubBranch ?? "main"}`) {
      return NextResponse.json({ ok: true, message: `ignored push to ${body.ref}` });
    }
  } catch {
    // No/invalid JSON body — treat as a manual trigger and refresh.
  }

  // Run refresh after the response is sent so GitHub gets a quick 200.
  // `after()` uses waitUntil so Vercel keeps the function alive until done.
  after(
    refreshGitHubModel(id).catch((err) =>
      logger.error("webhook refresh failed", { datasetId: id, ...serializeErr(err) }),
    ),
  );

  return NextResponse.json({ ok: true, message: "refresh triggered" });
}
