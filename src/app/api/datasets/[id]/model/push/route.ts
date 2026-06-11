// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db, datasets, malloyModels, malloyModelFiles } from "@/db";
import { requireAdminBearer } from "@/lib/bearer-auth";
import { introspectModelFiles } from "@/lib/malloy";
import { logger, serializeErr } from "@/lib/logger";

export const runtime = "nodejs";

const ENTRY = "index.malloy";

interface ModelFile {
  path: string;
  content: string;
}
interface GitInfo {
  repo?: string;
  branch?: string;
  sha?: string;
  dirty?: boolean;
}
interface PushBody {
  files?: ModelFile[];
  config?: string;
  git?: GitInfo;
}

function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status });
}

// Best-effort: an unresolved import surfaces as an error mentioning a file URL that
// isn't in the uploaded set. Helps the CLI give the push-specific hint.
function classifyCompileError(error: string, paths: Set<string>): "missing-import" | "compile" {
  for (const m of error.matchAll(/file:\/\/\/([^\s'"]+)/g)) {
    if (!paths.has(m[1])) return "missing-import";
  }
  return "compile";
}

function generatedBy(git: GitInfo): string {
  if (!git.repo && !git.sha) return "cli:local";
  const branch = git.branch ?? "?";
  const sha = git.sha ? `#${git.sha.slice(0, 7)}` : "";
  return `cli:${git.repo ?? "?"}@${branch}${sha}`;
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminBearer(req);
  if (!auth.ok) return json(auth.status, { ok: false, error: auth.error });

  const { id } = await ctx.params;
  // Datasets must pre-exist — publish never auto-creates (design §4.5).
  const [ds] = await db.select().from(datasets).where(eq(datasets.id, id)).limit(1);
  if (!ds) return json(404, { ok: false, error: `dataset "${id}" not found` });

  let body: PushBody;
  try {
    body = (await req.json()) as PushBody;
  } catch {
    return json(400, { ok: false, kind: "request", error: "invalid JSON body" });
  }

  const files = body.files ?? [];
  if (files.length === 0) {
    return json(400, { ok: false, kind: "request", error: "no files in payload" });
  }
  if (!files.some((f) => f.path === ENTRY)) {
    return json(400, {
      ok: false,
      kind: "request",
      error: `no ${ENTRY} at the root of the uploaded directory`,
    });
  }

  const git = body.git ?? {};
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";

  // Build the file map the same way the github path does: model files + malloy-config.json.
  const fileMap = new Map<string, string>(files.map((f) => [f.path, f.content]));
  if (body.config) fileMap.set("malloy-config.json", body.config);

  const result = await introspectModelFiles(fileMap, ENTRY);

  if (!result.ok) {
    const kind = classifyCompileError(result.error, new Set(fileMap.keys()));
    logger.info("model push rejected", { datasetId: id, kind, dryRun, error: result.error });
    // Record the failed attempt on the dataset — but never as a model version (§4.4).
    if (!dryRun) {
      await db
        .update(datasets)
        .set({
          lastPublishAt: new Date(),
          lastPublishSha: git.sha ?? null,
          lastPublishBranch: git.branch ?? null,
          lastPublishError: result.error,
        })
        .where(eq(datasets.id, id));
    }
    return json(400, { ok: false, kind, error: result.error });
  }

  if (dryRun) {
    return json(200, { ok: true, dryRun: true, sources: result.sources, git });
  }

  try {
    const created = await db.transaction(async (tx) => {
      const [latest] = await tx
        .select({ version: malloyModels.version })
        .from(malloyModels)
        .where(eq(malloyModels.datasetId, ds.id))
        .orderBy(desc(malloyModels.createdAt))
        .limit(1);
      const nextVersion = (latest?.version ?? 0) + 1;

      const indexContent = fileMap.get(ENTRY) ?? "";
      const [model] = await tx
        .insert(malloyModels)
        .values({
          datasetId: ds.id,
          version: nextVersion,
          source: indexContent,
          generatedBy: generatedBy(git),
          compiledAt: new Date(),
          sources: result.sources,
          gitRepo: git.repo ?? null,
          gitBranch: git.branch ?? null,
          gitSha: git.sha ?? null,
          gitDirty: git.dirty ?? null,
        })
        .returning();

      await tx.insert(malloyModelFiles).values(
        Array.from(fileMap.entries()).map(([path, content]) => ({
          modelId: model.id,
          path,
          content,
        })),
      );

      await tx
        .update(datasets)
        .set({
          lastPublishAt: new Date(),
          lastPublishSha: git.sha ?? null,
          lastPublishBranch: git.branch ?? null,
          lastPublishError: null,
        })
        .where(eq(datasets.id, ds.id));

      return model;
    });

    logger.info("model push ok", {
      datasetId: id,
      version: created.version,
      sourceCount: result.sources.length,
      fileCount: fileMap.size,
      generatedBy: created.generatedBy,
    });

    return json(200, {
      ok: true,
      version: created.version,
      sources: result.sources,
      compiledAt: created.compiledAt,
      git,
    });
  } catch (err) {
    logger.error("model push persist failed", { datasetId: id, ...serializeErr(err) });
    return json(500, { ok: false, error: "failed to persist model" });
  }
}
