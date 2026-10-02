// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { datasetTitle } from "@malloyyo/mcp-engine";
import { and, desc, eq } from "drizzle-orm";
import { db, datasets, malloyArtifacts, repoRevisions, repos } from "@/db";
import { latestModel, modelFileMap } from "@/lib/mcp-tools";
import { qualifiedName, resolveDatasetRef } from "@/lib/repos";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { isAdmin } from "@/lib/admin";
import { captureTelemetry } from "@/lib/telemetry";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: RouteContext<"/api/datasets/[id]">,
) {
  const { id } = await ctx.params;
  // A uuid, `repo:dataset`, an old bare name (pinned by an alias), or a bare
  // name that is still unambiguous - one ordered rule, in src/lib/repos.ts, so
  // every surface resolves a ref the same way.
  const resolved = await resolveDatasetRef(id);
  if (!resolved.ok) {
    return NextResponse.json(
      { error: resolved.ambiguous ? resolved.error : "not found" },
      { status: resolved.ambiguous ? 409 : 404 },
    );
  }
  const ds = resolved.dataset;
  const repo = resolved.repo;

  let me;
  try { me = await getSessionUser(); } catch (err) {
    if (err instanceof UnauthorizedError) {
      if (!ds.isPublic) return NextResponse.json({ error: "not found" }, { status: 404 });
      me = null;
    } else throw err;
  }

  if (me && !ds.isPublic && !isAdmin(me) && ds.userId !== me.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // last-publish detail (incl. failure text) is management-only — don't expose to public viewers.
  const canManage = me ? isAdmin(me) || ds.userId === me.id : false;

  // The model the dataset SERVES, and the files it serves with - which for a
  // repo-backed model come out of its revision's zip rather than a per-file
  // table (src/lib/repo-files.ts).
  const model = await latestModel(ds.id);
  const files = model
    ? [...(await modelFileMap(model, ds.repoDir))]
        .map(([path, content]) => ({ path, content }))
        .sort((a, b) => a.path.localeCompare(b.path))
    : [];

  // Dashboard artifacts (manifest + Dashboard.tsx) shown alongside the model files.
  const dashboards = model
    ? await db
        .select({
          name: malloyArtifacts.name,
          title: malloyArtifacts.title,
          manifest: malloyArtifacts.manifest,
          source: malloyArtifacts.source,
        })
        .from(malloyArtifacts)
        .where(eq(malloyArtifacts.modelId, model.id))
        .orderBy(malloyArtifacts.name)
    : [];

  const [live] = repo
    ? await db
        .select()
        .from(repoRevisions)
        .where(and(eq(repoRevisions.repoId, repo.id), eq(repoRevisions.active, true)))
        .limit(1)
    : [];

  return NextResponse.json({
    id: ds.id, name: ds.name,
    status: ds.status, statusError: ds.statusError,
    createdAt: ds.createdAt, readyAt: ds.readyAt,
    isPublic: ds.isPublic,
    // The label. `name` stays the identity — URLs, grants and publishes use it.
    title: datasetTitle(ds.name, ds.title),
    // The public identity. `name` stays the local one, which is what the repo's
    // own directories and dashboards are written against.
    qualified: qualifiedName(repo?.slug, ds.name),
    // THE REPO'S, not the dataset's. These were two nullable text columns on
    // every dataset row that any admin could edit one row at a time; one repo in
    // the production fork had three rows disagreeing about its credential, and
    // the refresh resolved it with `rows[0]` on an unordered query.
    repo: repo ? { slug: repo.slug, title: repo.title, ownerId: repo.ownerId } : null,
    githubRepo: repo?.githubRepo ?? null,
    githubBranch: repo?.githubBranch ?? null,
    // Where this dataset lives in a multi-dataset repo; "" is the root. The
    // "view source on GitHub" link needs it, because served paths are re-rooted.
    repoDir: ds.repoDir,
    githubUseToken: repo?.githubUseToken ?? false,
    revision: live ? { id: live.id, revision: live.revision, sha: live.gitSha, source: live.source } : null,
    isAdmin: me ? isAdmin(me) : false,
    dashboards,
    lastPublish:
      canManage && ds.lastPublishAt
        ? {
            at: ds.lastPublishAt,
            sha: ds.lastPublishSha,
            branch: ds.lastPublishBranch,
            error: ds.lastPublishError,
          }
        : null,
    malloyModel: model
      ? {
          id: model.id,
          source: model.source,
          generatedBy: model.generatedBy,
          compiledAt: model.compiledAt,
          sources: model.sources
            ? (model.sources as Array<string | { name: string }>).map((s) => typeof s === "string" ? s : s.name)
            : null,
          files: files.length > 0 ? files : null,
          git:
            model.gitRepo || model.gitSha
              ? { repo: model.gitRepo, branch: model.gitBranch, sha: model.gitSha, dirty: model.gitDirty }
              : null,
        }
      : null,
  });
}

export async function PATCH(
  req: Request,
  ctx: RouteContext<"/api/datasets/[id]">,
) {
  let me;
  try { me = await getSessionUser(); } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "sign in required" }, { status: 401 });
    throw err;
  }
  if (!isAdmin(me)) return NextResponse.json({ error: "admin required" }, { status: 403 });

  const { id } = await ctx.params;
  const body = (await req.json()) as {
    isPublic?: boolean;
    githubRepo?: string | null;
    githubBranch?: string | null;
    githubUseToken?: boolean;
  };

  const [ds] = await db.select().from(datasets).where(eq(datasets.id, id)).limit(1);
  if (!ds) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (body.isPublic !== undefined) {
    await db.update(datasets).set({ isPublic: body.isPublic }).where(eq(datasets.id, id));
  }

  // THE GITHUB ATTACHMENT IS THE REPO'S. Writing it here per dataset is what
  // made one repo in production carry three rows with two different credential
  // answers - and the config form hardcoded `githubUseToken: true` on every save
  // while the CLI publish path wrote `false`, so any repo touched by both had
  // mixed values by construction. Accepted on this route because the config form
  // still posts here, and applied to the repo, once.
  const touchesRepo =
    body.githubRepo !== undefined || body.githubBranch !== undefined || body.githubUseToken !== undefined;
  let repo = ds.repoId ? (await db.select().from(repos).where(eq(repos.id, ds.repoId)).limit(1))[0] : undefined;
  if (touchesRepo) {
    if (!repo) {
      return NextResponse.json(
        {
          error:
            "no repo publishes this dataset, so there is no GitHub attachment to change. " +
            "Add the repo on this instance instead.",
        },
        { status: 400 },
      );
    }
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.githubRepo !== undefined) patch.githubRepo = body.githubRepo || null;
    if (body.githubBranch !== undefined) patch.githubBranch = body.githubBranch || null;
    if (body.githubUseToken !== undefined) patch.githubUseToken = body.githubUseToken;
    [repo] = await db.update(repos).set(patch).where(eq(repos.id, repo.id)).returning();
  }

  const [updated] = await db.select().from(datasets).where(eq(datasets.id, id)).limit(1);
  return NextResponse.json({
    id: updated.id,
    isPublic: updated.isPublic,
    repo: repo?.slug ?? null,
    githubRepo: repo?.githubRepo ?? null,
    githubBranch: repo?.githubBranch ?? null,
  });
}

export async function DELETE(
  _req: Request,
  ctx: RouteContext<"/api/datasets/[id]">,
) {
  let me;
  try { me = await getSessionUser(); } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "sign in required" }, { status: 401 });
    throw err;
  }
  if (!isAdmin(me)) return NextResponse.json({ error: "admin required" }, { status: 403 });

  const { id } = await ctx.params;
  const [ds] = await db.select().from(datasets).where(eq(datasets.id, id));
  if (!ds) return NextResponse.json({ error: "not found" }, { status: 404 });

  await db.delete(datasets).where(eq(datasets.id, id));
  void captureTelemetry({ event: "dataset removed", properties: {} }, me.id);
  return NextResponse.json({ ok: true });
}
