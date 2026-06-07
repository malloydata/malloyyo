// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { db, datasets, malloyModels, malloyModelFiles } from "@/db";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { isAdmin } from "@/lib/admin";
import { compileMalloy, compileMalloyFiles } from "@/lib/malloy";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

const Body = z.object({ source: z.string().min(1).max(50_000).optional() });

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
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

  const [model] = await db.select().from(malloyModels)
    .where(eq(malloyModels.datasetId, id))
    .orderBy(desc(malloyModels.createdAt))
    .limit(1);

  const files = model
    ? await db.select({ path: malloyModelFiles.path, content: malloyModelFiles.content })
        .from(malloyModelFiles).where(eq(malloyModelFiles.modelId, model.id))
    : [];

  // Multi-file GitHub model: compile stored files with a probe using the first known source.
  if (files.length > 0 && model) {
    const rawSource = (model.sources as Array<string | { name: string }> | null)?.[0];
    const firstSource = typeof rawSource === "string" ? rawSource : (rawSource?.name ?? ds.name);
    const probe = `run: ${firstSource} -> { aggregate: __probe is count() }`;
    const fileMap = new Map(files.map((f) => [f.path, f.content]));
    const result = await compileMalloyFiles(fileMap, "index.malloy", probe);
    if (!result.ok) logger.error("model compile failed (github)", { datasetId: id, modelId: model.id, error: result.error });
    return NextResponse.json(result);
  }

  // Single-file model (Claude-generated): use source from request body.
  const { source } = Body.parse(await req.json());
  if (!source) return NextResponse.json({ error: "source required" }, { status: 400 });
  const probe = `run: ${ds.name} -> { aggregate: __probe is count() }`;
  const result = await compileMalloy(source, probe);
  if (!result.ok) logger.error("model compile failed (single-file)", { datasetId: id, error: result.error });
  return NextResponse.json(result);
}
