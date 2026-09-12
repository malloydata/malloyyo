// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db, malloyModels } from "@/db";
import { requireBearer } from "@/lib/bearer-auth";
import { isAdmin } from "@/lib/admin";
import { resolveDatasetByRef } from "@/lib/mcp-tools";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  // The read half of the CLI's model surface, so it takes the same scope as a
  // push — a query-only token has no business reading publish provenance.
  const auth = await requireBearer(req, { scope: "publish" });
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  // `id` may be a dataset uuid OR a readable name (the ready dataset with that
  // name) — so malloy-config.json can target by name instead of a slug.
  const ds = await resolveDatasetByRef(id);
  if (!ds) return NextResponse.json({ ok: false, error: `dataset "${id}" not found` }, { status: 404 });
  // Same authority as publishing: the owner, or an admin.
  if (ds.userId !== auth.user.id && !isAdmin(auth.user)) {
    return NextResponse.json(
      {
        ok: false,
        error:
          `that account doesn't own dataset "${ds.name}" and isn't an admin on this instance`,
      },
      { status: 403 },
    );
  }

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
