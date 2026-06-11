// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db, datasets, malloyModels } from "@/db";
import { requireAdminBearer } from "@/lib/bearer-auth";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminBearer(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  const [ds] = await db.select().from(datasets).where(eq(datasets.id, id)).limit(1);
  if (!ds) return NextResponse.json({ ok: false, error: `dataset "${id}" not found` }, { status: 404 });

  // The live model is the latest version — only successfully-compiled models are ever
  // persisted, so latest == live == valid (design §4.4).
  const [model] = await db
    .select()
    .from(malloyModels)
    .where(eq(malloyModels.datasetId, ds.id))
    .orderBy(desc(malloyModels.createdAt))
    .limit(1);

  return NextResponse.json({
    ok: true,
    dataset: { name: ds.name, isPublic: ds.isPublic, status: ds.status },
    version: model?.version ?? null,
    sources: model?.sources ?? [],
    compiledAt: model?.compiledAt ?? null,
    compileError: model?.compileError ?? null,
    generatedBy: model?.generatedBy ?? null,
    git: model
      ? { repo: model.gitRepo, branch: model.gitBranch, sha: model.gitSha, dirty: model.gitDirty }
      : null,
    lastPublish: {
      at: ds.lastPublishAt,
      sha: ds.lastPublishSha,
      branch: ds.lastPublishBranch,
      error: ds.lastPublishError,
    },
  });
}
