// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { desc } from "drizzle-orm";
import { db, datasets, malloyModels, malloyModelFiles, users } from "@/db";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { isAdmin } from "@/lib/admin";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: RouteContext<"/api/datasets/[id]">,
) {
  const { id } = await ctx.params;
  const [ds] = await db.select().from(datasets).where(eq(datasets.id, id));
  if (!ds) return NextResponse.json({ error: "not found" }, { status: 404 });

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

  const [user] = await db.select().from(users).where(eq(users.id, ds.userId));
  const [model] = await db.select().from(malloyModels)
    .where(eq(malloyModels.datasetId, id))
    .orderBy(desc(malloyModels.createdAt))
    .limit(1);

  const files = model
    ? await db
        .select({ path: malloyModelFiles.path, content: malloyModelFiles.content })
        .from(malloyModelFiles)
        .where(eq(malloyModelFiles.modelId, model.id))
        .orderBy(malloyModelFiles.path)
    : [];

  return NextResponse.json({
    id: ds.id, name: ds.name,
    status: ds.status, statusError: ds.statusError,
    createdAt: ds.createdAt, readyAt: ds.readyAt,
    isPublic: ds.isPublic,
    githubRepo: ds.githubRepo ?? null,
    githubBranch: ds.githubBranch ?? null,
    githubUseToken: ds.githubUseToken,
    userSlug: user?.slug ?? null,
    isAdmin: me ? isAdmin(me) : false,
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
  const body = await req.json() as { isPublic?: boolean; githubRepo?: string | null; githubBranch?: string | null; githubUseToken?: boolean };
  const patch: Record<string, unknown> = {};
  if (body.isPublic !== undefined) patch.isPublic = body.isPublic;
  if (body.githubRepo !== undefined) patch.githubRepo = body.githubRepo ?? null;
  if (body.githubBranch !== undefined) patch.githubBranch = body.githubBranch ?? null;
  if (body.githubUseToken !== undefined) patch.githubUseToken = body.githubUseToken;
  const [updated] = await db.update(datasets).set(patch).where(eq(datasets.id, id)).returning();
  if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ id: updated.id, isPublic: updated.isPublic, githubRepo: updated.githubRepo, githubBranch: updated.githubBranch });
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
  return NextResponse.json({ ok: true });
}
