// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse, after } from "next/server";
import { eq } from "drizzle-orm";
import { db, datasets } from "@/db";
import { refreshGitHubModel } from "@/lib/github-refresh";
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

  const [ds] = await db.select({ id: datasets.id, githubRepo: datasets.githubRepo }).from(datasets).where(eq(datasets.id, id));
  if (!ds?.githubRepo) {
    // Return 200 anyway so GitHub doesn't retry endlessly.
    return NextResponse.json({ ok: false, error: "dataset not found or has no github_repo" });
  }

  // Run refresh after the response is sent so GitHub gets a quick 200.
  // `after()` uses waitUntil so Vercel keeps the function alive until done.
  after(
    refreshGitHubModel(id)
      .then((result) =>
        captureTelemetry({
          event: "model published",
          properties: {
            method: "github_webhook",
            outcome: result.ok ? "success" : "error",
            created_dataset: false,
            source_count: result.ok ? result.sources.length : 0,
            file_count: result.ok ? result.fileCount : 0,
            dashboard_count: result.ok ? result.dashboardCount : 0,
          },
        }),
      )
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
