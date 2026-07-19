// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { desc, eq } from "drizzle-orm";
import { modelArtifact, type ArtifactInfo } from "@malloyyo/mcp-engine";
import { db, datasets, malloyModels, malloyModelFiles, malloyArtifacts } from "@/db";
import { GitHubURLReader, fetchGitHubFile, listGitHubDir, parseGitHubRepo } from "./github";
import { introspectModelWithReader, withReaderRuntime, fileUrl, type SourceInfo } from "./malloy";
import { logger } from "./logger";

export type RefreshResult =
  | { ok: true; version: number; generatedBy: string; compiledAt: Date | null; sources: SourceInfo[]; fileCount: number; dashboardCount: number }
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

  // Structure v2: each dashboard is a `dashboards/<name>.malloy` compiled as its
  // OWN entry. List the directory, then compile each file through the SAME
  // on-demand `reader` — which fetches the dashboard file AND its transitive
  // imports into `reader.fetched`, so they're stored below with the model. This
  // is the server-side equivalent of the CLI's per-file `artifactForFile`
  // discovery. Non-fatal: a broken dashboard never fails the model refresh.
  const dashboards: Array<{ base: string; artifact: ArtifactInfo }> = [];
  try {
    const entries = await listGitHubDir(owner, repo, branch, "dashboards", { useToken: ds.githubUseToken });
    const bases = entries
      .filter((e) => e.type === "file" && e.name.endsWith(".malloy"))
      .map((e) => e.name.slice(0, -".malloy".length))
      .sort();
    if (bases.length) {
      type EngineRuntime = Parameters<typeof modelArtifact>[0];
      const found = await withReaderRuntime(reader, malloyConfig, async (runtime) => {
        const out: Array<{ base: string; artifact: ArtifactInfo }> = [];
        for (const base of bases) {
          const r = await modelArtifact(runtime as unknown as EngineRuntime, fileUrl(`dashboards/${base}.malloy`), base);
          if (r.ok && r.artifact) out.push({ base, artifact: r.artifact });
        }
        return out;
      });
      dashboards.push(...found);
    }
  } catch (e) {
    logger.warn("refreshGitHubModel dashboard discovery failed (non-fatal)", { datasetId, error: e instanceof Error ? e.message : String(e) });
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

  // Store the discovered v2 dashboards: a manifest carrying `entryFile` + `tiles`
  // + `dashboard_columns` (so the server runs each against its own file), plus
  // the optional flat component `dashboards/<name>.jsx|tsx` in `source`. Matches
  // what the CLI publish path produces. Non-fatal.
  let dashboardCount = 0;
  try {
    const rows: Array<typeof malloyArtifacts.$inferInsert> = [];
    for (const { base, artifact: a } of dashboards) {
      let source = "";
      for (const ext of ["jsx", "tsx"]) {
        try {
          source = await fetchGitHubFile(owner, repo, branch, `dashboards/${base}.${ext}`, { useToken: ds.githubUseToken });
          break;
        } catch {
          // no component with this extension — try the next / render the default
        }
      }
      const manifest: Record<string, unknown> = { title: a.title, entryFile: `dashboards/${base}.malloy` };
      if (a.tiles) manifest.tiles = a.tiles;
      // Single-query artifact (no tiles): persist its run-expression — the app
      // needs manifest.query to run/introspect it.
      else if (a.query) manifest.query = a.query;
      if (a.dashboard_columns !== undefined) manifest.dashboard_columns = a.dashboard_columns;
      if (a.description) manifest.description = a.description;
      if (a.givens) manifest.givens = a.givens;
      if (a.autorun === false) manifest.autorun = false;
      rows.push({ modelId: created.id, name: a.name || base, title: a.title, manifest, source });
    }
    if (rows.length > 0) await db.insert(malloyArtifacts).values(rows);
    dashboardCount = rows.length;
  } catch (e) {
    logger.warn("refreshGitHubModel dashboard ingestion failed (non-fatal)", { datasetId, error: e instanceof Error ? e.message : String(e) });
  }

  logger.info("refreshGitHubModel ok", { datasetId, repo: ds.githubRepo, version: created.version, sourceCount: result.sources.length, fileCount: reader.fetched.size, dashboardCount });
  return {
    ok: true,
    version: created.version,
    generatedBy: created.generatedBy,
    compiledAt: created.compiledAt,
    sources: result.sources,
    fileCount: reader.fetched.size,
    dashboardCount,
  };
}
