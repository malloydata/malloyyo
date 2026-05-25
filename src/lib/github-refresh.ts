import { desc, eq } from "drizzle-orm";
import { db, datasets, malloyModels, malloyModelFiles } from "@/db";
import { GitHubURLReader, parseGitHubRepo } from "./github";
import { introspectModelWithReader } from "./malloy";

export type RefreshResult =
  | { ok: true; version: number; generatedBy: string; compiledAt: Date | null; sources: string[]; fileCount: number }
  | { ok: false; error: string };

export async function refreshGitHubModel(datasetId: string): Promise<RefreshResult> {
  const [ds] = await db.select().from(datasets).where(eq(datasets.id, datasetId));
  if (!ds) return { ok: false, error: "dataset not found" };
  if (!ds.githubRepo) return { ok: false, error: "dataset has no github_repo configured" };

  const { owner, repo } = parseGitHubRepo(ds.githubRepo);
  const branch = ds.githubBranch ?? "main";

  const reader = new GitHubURLReader(owner, repo, branch, ds.githubUseToken);
  const result = await introspectModelWithReader(reader, "index.malloy");
  if (!result.ok) return { ok: false, error: result.error };

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

  if (reader.fetched.size > 0) {
    await db.insert(malloyModelFiles).values(
      Array.from(reader.fetched.entries()).map(([path, content]) => ({
        modelId: created.id,
        path,
        content,
      })),
    );
  }

  return {
    ok: true,
    version: created.version,
    generatedBy: created.generatedBy,
    compiledAt: created.compiledAt,
    sources: result.sources,
    fileCount: reader.fetched.size,
  };
}
