// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { z } from "zod";
import { eq, desc, ne, and } from "drizzle-orm";
import { db, datasets, users } from "@/db";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { isAdmin } from "@/lib/admin";
import { nameToSlug } from "@/lib/slug";
import { parseGitHubRepo } from "@/lib/github";
import { refreshGitHubModel } from "@/lib/github-refresh";
import { logger, serializeErr } from "@/lib/logger";
import { captureTelemetry } from "@/lib/telemetry";

export const runtime = "nodejs";

const GitHubBody = z.object({
  githubRepo: z.string().min(1),
  githubBranch: z.string().min(1).default("main"),
  name: z.string().min(1).max(64),
  useToken: z.boolean().default(true),
});

export async function POST(req: Request) {
  let user;
  try { user = await getSessionUser(); } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "sign in required" }, { status: 401 });
    throw err;
  }
  if (!isAdmin(user)) return NextResponse.json({ error: "admin required" }, { status: 403 });

  let raw: unknown;
  try { raw = await req.json(); } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  let body: ReturnType<typeof GitHubBody.parse>;
  try { body = GitHubBody.parse(raw); } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 400 });
  }

  const name = nameToSlug(body.name);
  // Names are used as URLs and must be unique among live datasets on the server.
  const [clash] = await db
    .select({ id: datasets.id })
    .from(datasets)
    .where(and(eq(datasets.name, name), eq(datasets.status, "ready")))
    .limit(1);
  if (clash) {
    return NextResponse.json({ error: `a dataset named "${name}" already exists on this server` }, { status: 409 });
  }

  try {
    parseGitHubRepo(body.githubRepo);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 400 });
  }
  const branch = body.githubBranch;

  const id = crypto.randomUUID();
  const [row] = await db
    .insert(datasets)
    .values({
      id,
      userId: user.id,
      name,
      githubRepo: body.githubRepo,
      githubBranch: branch,
      githubUseToken: body.useToken,
      status: "modeling",
    })
    .returning();

  try {
    // Initial creation and every later refresh must ingest the same repository shape.
    // Keeping a second root-model-only loader here once made a newly created dataset omit
    // dashboards until somebody manually refreshed it.
    const result = await refreshGitHubModel(id);
    if (!result.ok) {
      void captureTelemetry(
        {
          event: "model published",
          properties: {
            method: "github_create",
            outcome: "error",
            created_dataset: true,
            source_count: 0,
            file_count: 0,
            dashboard_count: 0,
          },
        },
        user.id,
      );
      logger.error("dataset model introspection failed", { datasetId: id, repo: body.githubRepo, branch, error: result.error });
      await db.update(datasets).set({ status: "failed", statusError: result.error }).where(eq(datasets.id, id));
      return NextResponse.json({ id: row.id, error: result.error, status: "failed" }, { status: 422 });
    }

    await db.update(datasets).set({ status: "ready", readyAt: new Date() }).where(eq(datasets.id, id));
    void captureTelemetry(
      {
        event: "model published",
        properties: {
          method: "github_create",
          outcome: "success",
          created_dataset: true,
          source_count: result.sources.length,
          file_count: result.fileCount,
          dashboard_count: result.dashboardCount,
        },
      },
      user.id,
    );
    return NextResponse.json({ id: row.id, name, status: "ready", sources: result.sources });
  } catch (err) {
    void captureTelemetry(
      {
        event: "model published",
        properties: {
          method: "github_create",
          outcome: "error",
          created_dataset: true,
          source_count: 0,
          file_count: 0,
          dashboard_count: 0,
        },
      },
      user.id,
    );
    logger.error("POST /api/datasets uncaught error", { datasetId: id, ...serializeErr(err) });
    const msg = err instanceof Error ? err.message : String(err);
    await db.update(datasets).set({ status: "failed", statusError: msg }).where(eq(datasets.id, id)).catch(() => {});
    return NextResponse.json({ id, error: msg, status: "failed" }, { status: 500 });
  }
}

export async function GET() {
  let user;
  try { user = await getSessionUser(); } catch (err) {
    if (err instanceof UnauthorizedError) {
      const rows = await db
        .select({ id: datasets.id, name: datasets.name, status: datasets.status,
          createdAt: datasets.createdAt, readyAt: datasets.readyAt, isPublic: datasets.isPublic })
        .from(datasets).where(and(eq(datasets.isPublic, true), ne(datasets.status, "failed"))).orderBy(desc(datasets.createdAt)).limit(50);
      return NextResponse.json(rows);
    }
    throw err;
  }

  if (isAdmin(user)) {
    const rows = await db
      .select({
        id: datasets.id, name: datasets.name,
        status: datasets.status,
        createdAt: datasets.createdAt, readyAt: datasets.readyAt,
        isPublic: datasets.isPublic,
        ownerEmail: users.email, ownerName: users.name, ownerId: users.id,
      })
      .from(datasets)
      .leftJoin(users, eq(datasets.userId, users.id))
      .where(ne(datasets.status, "failed"))
      .orderBy(desc(datasets.createdAt))
      .limit(50);
    return NextResponse.json(rows);
  }

  const rows = await db
    .select({ id: datasets.id, name: datasets.name, status: datasets.status,
      createdAt: datasets.createdAt, readyAt: datasets.readyAt, isPublic: datasets.isPublic })
    .from(datasets).where(and(eq(datasets.isPublic, true), ne(datasets.status, "failed"))).orderBy(desc(datasets.createdAt)).limit(50);
  return NextResponse.json(rows);
}
