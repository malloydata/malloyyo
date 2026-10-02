// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse, after } from "next/server";
import { eq } from "drizzle-orm";
import { db, datasets } from "@/db";
import { refreshRepo } from "@/lib/github-refresh";
import { logger, serializeErr } from "@/lib/logger";
import { verifyGitHubSignature } from "@/lib/github-webhook";
import { captureTelemetry } from "@/lib/telemetry";

export const runtime = "nodejs";

// Public endpoint — no session auth. GitHub calls this on push events to
// refresh the Malloy model. Authentication is the HMAC signature when
// GITHUB_WEBHOOK_SECRET is configured; otherwise the dataset UUID in the URL.
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  // Read the body before touching the database: an unsigned caller should not
  // be able to make us do work, and the raw text is what the HMAC covers (a
  // parse-then-restringify would change the bytes and never match).
  const rawBody = await req.text();
  if (!verifyGitHubSignature(rawBody, req.headers.get("x-hub-signature-256"))) {
    logger.warn("webhook signature rejected", { datasetId: id });
    return NextResponse.json({ ok: false, error: "invalid signature" }, { status: 401 });
  }

  const [ds] = await db
    .select({ id: datasets.id, githubRepo: datasets.githubRepo, githubBranch: datasets.githubBranch })
    .from(datasets)
    .where(eq(datasets.id, id));
  if (!ds?.githubRepo) {
    // Return 200 anyway so GitHub doesn't retry endlessly.
    return NextResponse.json({ ok: false, error: "dataset not found or has no github_repo" });
  }
  const repo = ds.githubRepo;
  const branch = ds.githubBranch ?? "main";

  // A repo has ONE webhook, and a push refreshes the repo — not the dataset whose
  // id happens to be in the URL. The commit that changed `datasets/finance/` may
  // equally have changed a `lib/` every other dataset imports, and they all move
  // together or none do (src/lib/github-refresh.ts).
  after(
    refreshRepo(repo, branch)
      .then((result) => {
        if ("error" in result) {
          logger.error("webhook repo refresh failed", { repo, branch, error: result.error });
          return captureTelemetry({
            event: "model published",
            properties: {
              method: "github_webhook",
              outcome: "error",
              created_dataset: false,
              source_count: 0,
              file_count: 0,
              dashboard_count: 0,
            },
          });
        }
        // Nobody is reading an exit code here, so the log is the whole signal.
        if (result.failed.length > 0) {
          logger.error("webhook repo refresh wrote NOTHING — a dataset did not compile", {
            repo,
            branch,
            sha: result.sha,
            failed: result.failed,
          });
        }
        if (result.unpublished.length > 0) {
          logger.warn("repo no longer publishes these datasets; they were left untouched", {
            repo,
            branch,
            unpublished: result.unpublished.map((u) => `${u.name} (${u.dir})`),
          });
        }
        if (result.unclaimed.length > 0) {
          logger.warn("repo publishes directories no dataset covers — add them to create them", {
            repo,
            branch,
            unclaimed: result.unclaimed.map((u) => u.dir),
          });
        }
        return captureTelemetry({
          event: "model published",
          properties: {
            method: "github_webhook",
            outcome: result.failed.length > 0 ? "error" : "success",
            created_dataset: false,
            source_count: 0,
            file_count: 0,
            dashboard_count: 0,
          },
        });
      })
      .catch((err) => {
        void captureTelemetry({
          event: "model published",
          properties: {
            method: "github_webhook",
            outcome: "error",
            created_dataset: false,
            source_count: 0,
            file_count: 0,
            dashboard_count: 0,
          },
        });
        logger.error("webhook refresh failed", { datasetId: id, ...serializeErr(err) });
      }),
  );

  return NextResponse.json({ ok: true, message: "refresh triggered" });
}
