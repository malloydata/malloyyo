// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * `POST /api/datasets/:id/webhook/github` — the hook URL that already exists.
 *
 * A webhook belongs to a repo, and `/api/repos/:id/webhook/github` is where it
 * belongs. This route stays because these URLs are configured in people's GitHub
 * repositories right now, and a rewrite is not a reason to break them: it finds
 * the dataset's repo and does exactly what the repo-scoped route does.
 */

import { NextResponse, after } from "next/server";
import { eq } from "drizzle-orm";
import { db, datasets } from "@/db";
import { verifyGitHubSignature } from "@/lib/github-webhook";
import { handleRepoPush } from "@/lib/repo-webhook";
import { repoById } from "@/lib/repos";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

// Public endpoint — no session auth. Authentication is the HMAC signature when
// GITHUB_WEBHOOK_SECRET is configured; otherwise the dataset UUID in the URL.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  // Read the body before touching the database: an unsigned caller should not
  // be able to make us do work, and the raw text is what the HMAC covers.
  const rawBody = await req.text();
  if (!verifyGitHubSignature(rawBody, req.headers.get("x-hub-signature-256"))) {
    logger.warn("webhook signature rejected", { datasetId: id });
    return NextResponse.json({ ok: false, error: "invalid signature" }, { status: 401 });
  }

  const [ds] = await db
    .select({ id: datasets.id, repoId: datasets.repoId })
    .from(datasets)
    .where(eq(datasets.id, id));
  // 200 anyway so GitHub does not retry endlessly.
  if (!ds?.repoId) {
    return NextResponse.json({ ok: false, error: "dataset not found, or no repo publishes it" });
  }
  const repo = await repoById(ds.repoId);
  if (!repo) return NextResponse.json({ ok: false, error: "this dataset's repo is gone" });
  if (!repo.githubRepo) {
    return NextResponse.json({ ok: false, error: `the repo "${repo.slug}" is not attached to GitHub` });
  }

  // A push refreshes the REPO, not the dataset whose id happens to be in the
  // URL: the commit that changed `datasets/finance/` may equally have changed a
  // `lib/` every other dataset imports, and they all move together or none do.
  after(handleRepoPush(repo.id, repo.slug));
  return NextResponse.json({ ok: true, repo: repo.slug, message: "refresh triggered" });
}
