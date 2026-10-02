// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * `POST /api/repos/:id/webhook/github` — the push hook, on the repo.
 *
 * A webhook is a REPO-level fact: one repo, one hook, and a push to it means
 * "pull the repo". It used to hang off a dataset id, which was the only handle
 * that existed — and that was wrong in a way you could feel: the hook for a
 * four-dataset repo was addressed by whichever of them the person happened to be
 * looking at, and deleting that dataset broke the hook for the other three.
 *
 * The dataset-scoped URL still works (`/api/datasets/:id/webhook/github`),
 * because those URLs are already in people's GitHub settings.
 */

import { NextResponse, after } from "next/server";
import { verifyGitHubSignature } from "@/lib/github-webhook";
import { handleRepoPush } from "@/lib/repo-webhook";
import { repoById } from "@/lib/repos";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

// Public endpoint — no session auth. Authentication is the HMAC signature when
// GITHUB_WEBHOOK_SECRET is configured; otherwise the repo UUID in the URL.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  // Read the body before touching the database: an unsigned caller should not
  // be able to make us do work, and the raw text is what the HMAC covers (a
  // parse-then-restringify would change the bytes and never match).
  const rawBody = await req.text();
  if (!verifyGitHubSignature(rawBody, req.headers.get("x-hub-signature-256"))) {
    logger.warn("webhook signature rejected", { repoId: id });
    return NextResponse.json({ ok: false, error: "invalid signature" }, { status: 401 });
  }

  const repo = await repoById(id);
  // 200 anyway, so GitHub does not retry endlessly on a hook for a repo that
  // has been removed.
  if (!repo) return NextResponse.json({ ok: false, error: "no such repo" });
  if (!repo.githubRepo) {
    return NextResponse.json({ ok: false, error: `the repo "${repo.slug}" is not attached to GitHub` });
  }

  after(handleRepoPush(repo.id, repo.slug));
  return NextResponse.json({ ok: true, repo: repo.slug, message: "refresh triggered" });
}
