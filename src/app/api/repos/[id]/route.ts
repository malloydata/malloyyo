// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * `GET|PATCH /api/repos/:id` — the repo, and its settings.
 *
 * `:id` is the repo's slug or its uuid, the same way a dataset's route takes
 * either, so a link can be readable.
 *
 * These settings used to be edited on a DATASET's config page, which wrote them
 * to that one row. A repo with four datasets therefore offered four copies of
 * one set of settings, each independently editable, and one repo in production
 * ended up with three rows disagreeing about its credential. There is one row to
 * write now, and this is the only thing that writes it.
 */

import { NextResponse } from "next/server";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { db, datasets, repos, repoRevisions, malloyModels } from "@/db";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { isAdmin } from "@/lib/admin";
import { parseGitHubRepo } from "@/lib/github";
import { qualifiedName } from "@/lib/repos";
import { datasetTitle, repoPath } from "@malloyyo/mcp-engine";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function load(ref: string) {
  const [repo] = await db
    .select()
    .from(repos)
    .where(UUID.test(ref) ? eq(repos.id, ref) : eq(repos.slug, ref))
    .limit(1);
  return repo ?? null;
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let me;
  try {
    me = await getSessionUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "sign in required" }, { status: 401 });
    throw err;
  }
  // Admin-only, like the dataset config page this replaces: a repo's settings
  // name the GitHub it will be compiled from, and compiling runs SQL against
  // this server's own connections.
  if (!isAdmin(me)) return NextResponse.json({ error: "admin required" }, { status: 403 });

  const { id } = await ctx.params;
  const repo = await load(id);
  if (!repo) return NextResponse.json({ error: "not found" }, { status: 404 });

  const [live] = await db
    .select()
    .from(repoRevisions)
    .where(and(eq(repoRevisions.repoId, repo.id), eq(repoRevisions.active, true)))
    .limit(1);

  const history = await db
    .select({
      id: repoRevisions.id,
      revision: repoRevisions.revision,
      source: repoRevisions.source,
      active: repoRevisions.active,
      verifiedAt: repoRevisions.verifiedAt,
      verifyError: repoRevisions.verifyError,
      gitSha: repoRevisions.gitSha,
      archiveBytes: repoRevisions.archiveBytes,
      createdAt: repoRevisions.createdAt,
    })
    .from(repoRevisions)
    .where(eq(repoRevisions.repoId, repo.id))
    .orderBy(desc(repoRevisions.revision))
    .limit(20);

  const members = await db
    .select({
      id: datasets.id,
      name: datasets.name,
      title: datasets.title,
      status: datasets.status,
      repoDir: datasets.repoDir,
      createdAt: datasets.createdAt,
      isPublic: datasets.isPublic,
      /** Still served from per-file rows: no model of its own carries a revision. */
      legacyModels: sql<number>`(
        select count(*) from ${malloyModels}
        where ${malloyModels.datasetId} = ${datasets.id} and ${malloyModels.revisionId} is null
      )`,
    })
    .from(datasets)
    .where(eq(datasets.repoId, repo.id))
    .orderBy(asc(datasets.name));

  return NextResponse.json({
    id: repo.id,
    slug: repo.slug,
    title: repo.title,
    githubRepo: repo.githubRepo,
    githubBranch: repo.githubBranch,
    githubUseToken: repo.githubUseToken,
    createdAt: repo.createdAt,
    // Null means nothing has been published yet — for an instance that upgraded,
    // it means this repo has never been refetched since.
    live: live ? { revision: live.revision, verifiedAt: live.verifiedAt, gitSha: live.gitSha } : null,
    needsUpdate: !live,
    history,
    datasets: members.map((d) => ({
      ...d,
      qualified: qualifiedName(repo.slug, d.name),
      displayTitle: datasetTitle(d.name, d.title),
      // The file this dataset is, rather than the directory it is in. A dataset
      // at the repo root has no directory to name, and "no directory" described
      // an absence instead of the thing that is there.
      entryFile: `./${repoPath(d.repoDir, "index.malloy")}`,
    })),
  });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let me;
  try {
    me = await getSessionUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "sign in required" }, { status: 401 });
    throw err;
  }
  if (!isAdmin(me)) return NextResponse.json({ error: "admin required" }, { status: 403 });

  const { id } = await ctx.params;
  const repo = await load(id);
  if (!repo) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as {
    githubRepo?: string | null;
    githubBranch?: string | null;
    githubUseToken?: boolean;
  } | null;
  if (!body) return NextResponse.json({ error: "bad request" }, { status: 400 });

  const patch: Record<string, unknown> = {};

  if (body.githubRepo !== undefined) {
    const slug = body.githubRepo?.trim() || null;
    if (slug) {
      // Validated here rather than discovered at the next refresh. An unparseable
      // slug is stored happily and then fails inside `repoContext`, where the
      // refresh button reports it as a server error rather than as the typo it is.
      try {
        parseGitHubRepo(slug);
      } catch {
        return NextResponse.json(
          { error: `"${slug}" is not an owner/name GitHub repo` },
          { status: 400 },
        );
      }
      // One repo per coordinate: two rows claiming the same branch of the same
      // GitHub repo is what made "which datasets are this repo" ambiguous before
      // repos were rows at all.
      const branch = (body.githubBranch ?? repo.githubBranch)?.trim() || null;
      const [clash] = await db
        .select({ slug: repos.slug })
        .from(repos)
        .where(
          and(
            eq(repos.githubRepo, slug),
            branch === null ? isNull(repos.githubBranch) : eq(repos.githubBranch, branch),
          ),
        )
        .limit(1);
      if (clash && clash.slug !== repo.slug) {
        return NextResponse.json(
          { error: `${slug}@${branch ?? "(default)"} is already attached to the repo "${clash.slug}"` },
          { status: 409 },
        );
      }
    }
    patch.githubRepo = slug;
  }
  if (body.githubBranch !== undefined) patch.githubBranch = body.githubBranch?.trim() || null;
  if (body.githubUseToken !== undefined) patch.githubUseToken = body.githubUseToken;

  if (Object.keys(patch).length === 0) return NextResponse.json({ error: "nothing to change" }, { status: 400 });

  const [updated] = await db.update(repos).set(patch).where(eq(repos.id, repo.id)).returning();
  logger.info("repo settings changed", { repo: updated.slug, fields: Object.keys(patch) });

  return NextResponse.json({
    id: updated.id,
    slug: updated.slug,
    githubRepo: updated.githubRepo,
    githubBranch: updated.githubBranch,
    githubUseToken: updated.githubUseToken,
  });
}
