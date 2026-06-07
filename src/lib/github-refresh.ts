// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { desc, eq } from "drizzle-orm";
import { db, datasets, malloyModels, malloyModelFiles } from "@/db";
import { GitHubURLReader, fetchGitHubFile, parseGitHubRepo } from "./github";
import { introspectModelWithReader, type SourceInfo } from "./malloy";
import { logger } from "./logger";

export type RefreshResult =
  | { ok: true; version: number; generatedBy: string; compiledAt: Date | null; sources: SourceInfo[]; fileCount: number }
  | { ok: false; error: string };

export async function refreshGitHubModel(datasetId: string): Promise<RefreshResult> {
  const [ds] = await db.select().from(datasets).where(eq(datasets.id, datasetId));
  if (!ds) return { ok: false, error: "dataset not found" };
  if (!ds.githubRepo) return { ok: false, error: "dataset has no github_repo configured" };
  logger.info("refreshGitHubModel start", { datasetId, repo: ds.githubRepo, branch: ds.githubBranch ?? "main" });

  const { owner, repo } = parseGitHubRepo(ds.githubRepo);
  const branch = ds.githubBranch ?? "main";

  const reader = new GitHubURLReader(owner, repo, branch, ds.githubUseToken);

  // Fetch malloy-config.json from repo root — optional, absent in most repos.
  let malloyConfig: string | undefined;
  try {
    malloyConfig = await fetchGitHubFile(owner, repo, branch, "malloy-config.json", {
      useToken: ds.githubUseToken,
    });
  } catch {
    // Not present — fine.
  }

  const result = await introspectModelWithReader(reader, "index.malloy", malloyConfig);
  if (!result.ok) {
    logger.error("refreshGitHubModel introspection failed", { datasetId, repo: ds.githubRepo, error: result.error });
    return { ok: false, error: result.error };
  }

  const [latest] = await db
    .select({ version: malloyModels.version })
    .from(malloyModels)
    .where(eq(malloyModels.datasetId, ds.id))
    .orderBy(desc(malloyModels.createdAt))
    .limit(1);
  const nextVersion = (latest?.version ?? 0) + 1;

  const indexContent = reader.fetched.get("index.malloy") ?? "";
  const [created] = await db
    .insert(malloyModels)
    .values({
      datasetId: ds.id,
      version: nextVersion,
      source: indexContent,
      generatedBy: `github:${ds.githubRepo}@${branch}`,
      compiledAt: new Date(),
      sources: result.sources,
    })
    .returning();

  const allFiles = new Map(reader.fetched);
  if (malloyConfig) allFiles.set("malloy-config.json", malloyConfig);

  if (allFiles.size > 0) {
    await db.insert(malloyModelFiles).values(
      Array.from(allFiles.entries()).map(([path, content]) => ({
        modelId: created.id,
        path,
        content,
      })),
    );
  }

  logger.info("refreshGitHubModel ok", { datasetId, repo: ds.githubRepo, version: created.version, sourceCount: result.sources.length, fileCount: reader.fetched.size });
  return {
    ok: true,
    version: created.version,
    generatedBy: created.generatedBy,
    compiledAt: created.compiledAt,
    sources: result.sources,
    fileCount: reader.fetched.size,
  };
}
