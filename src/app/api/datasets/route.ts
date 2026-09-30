// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { z } from "zod";
import { eq, desc, ne, and, inArray } from "drizzle-orm";
import { db, datasets, users } from "@/db";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { isAdmin } from "@/lib/admin";
import { canAuthor, datasetVisibleWhere } from "@/lib/roles";
import { nameToSlug } from "@/lib/slug";
import { parseGitHubRepo } from "@/lib/github";
import { refreshGitHubModel, repoContext, type RepoContext } from "@/lib/github-refresh";
import { discoverRepoLayout } from "@/lib/repo-layout";
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
  // Admin only. Creating a dataset means naming a repo this server will compile,
  // and a model can reach the server's environment — see canAuthor.
  if (!canAuthor(user)) {
    return NextResponse.json({ error: "MALLOYYO_ADMIN required" }, { status: 403 });
  }

  let raw: unknown;
  try { raw = await req.json(); } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  let body: ReturnType<typeof GitHubBody.parse>;
  try { body = GitHubBody.parse(raw); } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 400 });
  }

  try {
    parseGitHubRepo(body.githubRepo);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 400 });
  }
  const branch = body.githubBranch;
  const { owner, repo } = parseGitHubRepo(body.githubRepo);

  // What shape is this repo? A root `index.malloy` is one dataset; a
  // `datasets/` directory is one per subdirectory, named after it. Both at once
  // is refused rather than guessed — see src/lib/repo-layout.ts.
  let layout;
  try {
    layout = await discoverRepoLayout(owner, repo, branch, { useToken: body.useToken });
  } catch (err) {
    logger.error("repo layout discovery failed", { repo: body.githubRepo, branch, ...serializeErr(err) });
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
  if (!layout.ok) return NextResponse.json({ error: layout.error }, { status: 400 });

  // A single-dataset repo is named by whoever is adding it; in a multi-dataset
  // repo the directory names it, because that is the name its own dashboards and
  // imports are written against.
  const planned: { name: string; dir: string | null }[] =
    layout.kind === "single"
      ? [{ name: nameToSlug(body.name), dir: null }]
      : layout.datasets.map((d) => ({ name: d.name, dir: d.dir }));

  // Every name is checked BEFORE any row is written. Names are URLs and must be
  // unique among live datasets, and a repo that half-lands because its third
  // directory collided is worse than one that does not land at all.
  const clashes: string[] = [];
  for (const item of planned) {
    const [clash] = await db
      .select({ id: datasets.id })
      .from(datasets)
      .where(and(eq(datasets.name, item.name), eq(datasets.status, "ready")))
      .limit(1);
    if (clash) clashes.push(item.name);
  }
  if (clashes.length > 0) {
    return NextResponse.json(
      {
        error:
          clashes.length === 1
            ? `a dataset named "${clashes[0]}" already exists on this server`
            : `these datasets already exist on this server: ${clashes.join(", ")}`,
      },
      { status: 409 },
    );
  }

  // ONE context for the whole repo: it holds the repo archive, and building it
  // per dataset would download the repo once per dataset — which is the cost
  // reading the archive exists to remove.
  let ctx: RepoContext;
  try {
    ctx = await repoContext({
      githubRepo: body.githubRepo,
      githubBranch: branch,
      githubUseToken: body.useToken,
    });
  } catch (err) {
    logger.error("could not read the repo", { repo: body.githubRepo, branch, ...serializeErr(err) });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  const created: { id: string; name: string; dir: string | null }[] = [];
  const failures: { name: string; error: string }[] = [];
  let lastResult: Awaited<ReturnType<typeof refreshGitHubModel>> | null = null;

  try {
    for (const item of planned) {
      const id = crypto.randomUUID();
      await db.insert(datasets).values({
        id,
        userId: user.id,
        name: item.name,
        githubRepo: body.githubRepo,
        githubBranch: branch,
        githubUseToken: body.useToken,
        repoDir: item.dir,
        status: "modeling",
      });
      created.push({ id, name: item.name, dir: item.dir });

      // Initial creation and every later refresh must ingest the same repository
      // shape. Keeping a second root-model-only loader here once made a newly
      // created dataset omit dashboards until somebody manually refreshed it.
      // `creating`: this is the dataset's first model, and no admin has had a
      // chance to tick what it is scoped by, so the model decides — the same rule
      // `malloyyo publish --create-dataset` applies. Every LATER refresh omits it,
      // so a model can never widen its own scope afterwards.
      const result = await refreshGitHubModel(id, { creating: true, ctx });
      if (!result.ok) {
        failures.push({ name: item.name, error: result.error });
        continue;
      }
      lastResult = result;
      await db.update(datasets).set({ status: "ready", readyAt: new Date() }).where(eq(datasets.id, id));
    }

    // All or nothing. A repo publishes as a unit: leaving two of four datasets
    // behind gives an instance that looks complete and is missing the one nobody
    // thinks to check. The rows were made in this request, so removing them
    // restores exactly the state we started in.
    if (failures.length > 0) {
      await db.delete(datasets).where(inArray(datasets.id, created.map((c) => c.id)));
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
      logger.error("dataset creation failed", { repo: body.githubRepo, branch, failures });
      const detail = failures.map((f) => `${f.name}: ${f.error}`).join("\n");
      return NextResponse.json(
        {
          error:
            planned.length > 1
              ? `nothing was created — ${failures.length} of ${planned.length} datasets in this repo failed to compile:\n${detail}`
              : failures[0].error,
          status: "failed",
          failures,
        },
        { status: 422 },
      );
    }

    void captureTelemetry(
      {
        event: "model published",
        properties: {
          method: "github_create",
          outcome: "success",
          created_dataset: true,
          source_count: lastResult?.ok ? lastResult.sources.length : 0,
          file_count: lastResult?.ok ? lastResult.fileCount : 0,
          dashboard_count: lastResult?.ok ? lastResult.dashboardCount : 0,
        },
      },
      user.id,
    );

    // One dataset answers as it always did, so nothing that adds a single repo
    // has to learn a new shape; several answer with the list.
    if (planned.length === 1) {
      return NextResponse.json({
        id: created[0].id,
        name: created[0].name,
        status: "ready",
        sources: lastResult?.ok ? lastResult.sources : [],
      });
    }
    return NextResponse.json({
      status: "ready",
      datasets: created.map((c) => ({ id: c.id, name: c.name, repoDir: c.dir })),
    });
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
    logger.error("POST /api/datasets uncaught error", { repo: body.githubRepo, ...serializeErr(err) });
    const msg = err instanceof Error ? err.message : String(err);
    if (created.length > 0) {
      await db.delete(datasets).where(inArray(datasets.id, created.map((c) => c.id))).catch(() => {});
    }
    return NextResponse.json({ error: msg, status: "failed" }, { status: 500 });
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

  // Owned, public, or opened by one of their roles — the same predicate the run
  // paths use, so a dataset someone can query is a dataset they can see listed.
  const rows = await db
    .select({ id: datasets.id, name: datasets.name, status: datasets.status,
      createdAt: datasets.createdAt, readyAt: datasets.readyAt, isPublic: datasets.isPublic })
    .from(datasets).where(datasetVisibleWhere(user.id)).orderBy(desc(datasets.createdAt)).limit(50);
  return NextResponse.json(rows);
}
