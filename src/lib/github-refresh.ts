// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * Pulling models out of a GitHub repo.
 *
 * THE REPO IS THE UNIT OF PUBLISH. A repo backs one dataset (an `index.malloy`
 * at its root) or several (`datasets/<name>/`), and either way it moves as one:
 * every dataset compiles before any is written, they land in a single
 * transaction, and they all record the same commit.
 *
 * The argument for that is about who is watching. A GitHub-backed repo refreshes
 * on a TRIGGER — a commit lands, the server pulls, and nobody reads an exit code.
 * Writing only the datasets that happened to compile would leave a repo's
 * datasets at different commits, built against different versions of a shared
 * `lib/`, with nothing having said so. Nothing can *query* across datasets, so no
 * result would be wrong; but whoever works out what is live has to do it per
 * dataset, with no reason to suspect they should. Uniform staleness is one
 * comparison. Mixed staleness is an investigation.
 *
 * `malloyyo lint` is the other half: it validates the WHOLE repo, so a broken
 * dataset should never reach the trigger. An atomic refusal here is the
 * exceptional case rather than the routine one.
 *
 * The DATASET stays the unit of access and of scoping. Roles and
 * `required_givens` are per dataset and none of this touches them.
 *
 * NOTHING HERE DESTROYS. Delete a dataset's directory and the repo simply stops
 * publishing it: that dataset is not refreshed, and nothing of it is removed —
 * the same as a model that stops exporting a source. Saved queries, share links
 * and history pointing at it are somebody's work, and a commit is not a decision
 * to throw that away.
 */

import { and, desc, eq } from "drizzle-orm";
import { modelArtifact, type ArtifactInfo } from "@malloyyo/mcp-engine";
import { db, datasets, malloyModels, malloyModelFiles, malloyArtifacts, type Dataset } from "@/db";
import {
  GitHubURLReader,
  fetchGitHubCommitSha,
  fetchGitHubFile,
  fetchGitHubTarball,
  listGitHubDir,
  listGitHubTree,
  parseGitHubRepo,
  dirFromTree,
  type GitHubDirEntry,
} from "./github";
import { ArchiveURLReader, archiveDir, archiveEntries, extractTarGz } from "./tarball";
import { DEVCONTAINER_PATH } from "./github-source-link";
import { introspectModelWithReader, withReaderRuntime, fileUrl, type SourceInfo } from "./malloy";
import { ABOUT_NAME, ABOUT_TITLE } from "@/lib/dashboards/about";
import { artifactManifest } from "@/lib/dashboards/manifest";
import { requirementForPublish } from "./tenancy";
import { discoverRepoLayout, layoutFromListing, repoPath, rerootFiles } from "./repo-layout";
import { logger } from "./logger";

export type RefreshResult =
  | {
      ok: true;
      version: number;
      generatedBy: string;
      compiledAt: Date | null;
      sources: SourceInfo[];
      fileCount: number;
      dashboardCount: number;
    }
  | { ok: false; error: string };

/** One dataset's worth of repo, compiled and ready to write. Nothing in here has
    touched the database. */
type Compiled = {
  sources: SourceInfo[];
  /** Re-rooted at the dataset's own directory — see repo-layout.rerootFiles. */
  files: Map<string, string>;
  artifacts: Array<Omit<typeof malloyArtifacts.$inferInsert, "modelId">>;
  /** What the dataset should be scoped by after this publish (creation only). */
  requiredGivens: string[] | null;
  indexContent: string;
};

/** What a compile needs that belongs to the REPO rather than to a dataset.
    Fetched once per refresh, however many datasets the repo holds. */
type RepoContext = {
  owner: string;
  repo: string;
  branch: string;
  useToken: boolean;
  slug: string;
  malloyConfig?: string;
  devcontainer?: string;
  sha: string | null;
  /**
   * Every path in the repo, from one request.
   *
   * Carried so a compile never asks GitHub whether a file exists: it can SEE.
   * Each dashboard used to cost up to two probes (`.jsx`, then `.tsx`), plus a
   * directory listing per dataset and two more probes for the About page — and
   * that multiplies by dataset, so the layout I added is what made it a problem.
   * Refreshing a four-dataset repo spent an unauthenticated instance's entire
   * hourly budget of sixty. Null when GitHub would not give the tree, and then
   * the probes are the fallback.
   */
  tree: GitHubDirEntry[] | null;
  /**
   * The whole repo, from ONE request.
   *
   * When this is present nothing below talks to GitHub again: the reader, the
   * dashboards listing, every component and the config all come out of it. Null
   * when the archive could not be had, and then each file is fetched on its own
   * — correct, just expensive, which is the state this replaces.
   */
  archive: Map<string, string> | null;
};

/** Does the repo contain this exact path? `null` tree means "ask GitHub". */
function treeHas(tree: GitHubDirEntry[] | null, path: string): boolean | null {
  if (!tree) return null;
  return tree.some((e) => e.type === "file" && e.path === path);
}

export async function repoContext(
  ds: Pick<Dataset, "githubRepo" | "githubBranch" | "githubUseToken">,
): Promise<RepoContext> {
  const slug = ds.githubRepo!;
  const { owner, repo } = parseGitHubRepo(slug);
  const branch = ds.githubBranch ?? "main";
  const useToken = ds.githubUseToken;

  // The repo, in one request. Everything else in this function — and every file
  // any dataset's compile asks for — comes out of it.
  let archive: Map<string, string> | null = null;
  const tgz = await fetchGitHubTarball(owner, repo, branch, { useToken });
  if (tgz) {
    try {
      const extracted = extractTarGz(tgz);
      archive = extracted.files;
      logger.info("repo archive read", {
        repo: slug,
        branch,
        files: archive.size,
        skipped: extracted.skipped.length,
        bytes: tgz.length,
      });
    } catch (e) {
      // A repo we cannot unpack is one we can still read file by file.
      logger.warn("repo archive unreadable — falling back to per-file reads", {
        repo: slug,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Both belong to the REPO and are shared by every dataset in it: connections
  // are the repo's, and the dev container is kept for its EXISTENCE rather than
  // its content, so the app can tell whether the repo opens as a working
  // codespace without asking GitHub again on every page view.
  let malloyConfig: string | undefined;
  let devcontainer: string | undefined;
  if (archive) {
    malloyConfig = archive.get("malloy-config.json");
    devcontainer = archive.get(DEVCONTAINER_PATH);
  } else {
    try {
      malloyConfig = await fetchGitHubFile(owner, repo, branch, "malloy-config.json", { useToken });
    } catch {
      // Not present — most repos have none, and DuckDB is the default world.
    }
    try {
      devcontainer = await fetchGitHubFile(owner, repo, branch, DEVCONTAINER_PATH, { useToken });
    } catch {
      // No dev container — the UI says so when someone asks for a codespace.
    }
  }

  const sha = await fetchGitHubCommitSha(owner, repo, branch, { useToken });
  const tree = archive ? null : await listGitHubTree(owner, repo, branch, { useToken });
  return { owner, repo, branch, useToken, slug, malloyConfig, devcontainer, sha, tree, archive };
}

/**
 * Compile one dataset out of the repo: read GitHub, compile Malloy, write
 * NOTHING. Split from the write so a caller can compile every dataset in a repo
 * and only then decide whether any of them may land.
 */
async function compileDataset(
  ds: Pick<Dataset, "id" | "repoDir" | "requiredGivens">,
  ctx: RepoContext,
  opts: { creating?: boolean } = {},
): Promise<{ ok: true; compiled: Compiled } | { ok: false; error: string }> {
  const { owner, repo, branch, useToken } = ctx;
  const reader = ctx.archive
    ? new ArchiveURLReader(ctx.archive)
    : new GitHubURLReader(owner, repo, branch, useToken);

  // Where this dataset lives. NULL is the repo root — every single-dataset repo,
  // and every row that predates multi-dataset repos.
  const entryPath = repoPath(ds.repoDir, "index.malloy");
  const dashboardsDir = repoPath(ds.repoDir, "dashboards");

  const result = await introspectModelWithReader(reader, entryPath, ctx.malloyConfig);
  if (!result.ok) return { ok: false, error: result.error };

  // A REFRESH never widens what a dataset is scoped by: the dataset's list wins,
  // and a model that stopped declaring it is refused rather than quietly serving
  // unscoped. Only creation passes `creating`, where no admin has had a chance to
  // tick anything yet.
  const requirement = requirementForPublish(ds.requiredGivens ?? [], result.declaredGivens, {
    creating: opts.creating,
  });
  if (!requirement.ok) return { ok: false, error: requirement.error };

  // Structure v2: each dashboard is a `dashboards/<name>.malloy` compiled as its
  // OWN entry, through the SAME on-demand `reader` — which pulls the dashboard
  // file AND its transitive imports into `reader.fetched`, so they are stored
  // with the model. Non-fatal: a broken dashboard never fails the model.
  const dashboards: Array<{ base: string; artifact: ArtifactInfo }> = [];
  let bases: string[] = [];
  try {
    const names = ctx.archive
      ? archiveDir(ctx.archive, dashboardsDir)
      : (ctx.tree
          ? dirFromTree(ctx.tree, dashboardsDir)
          : await listGitHubDir(owner, repo, branch, dashboardsDir, { useToken })
        )
          .filter((e) => e.type === "file")
          .map((e) => e.name);
    bases = names
      .filter((n) => n.endsWith(".malloy"))
      .map((n) => n.slice(0, -".malloy".length))
      .sort();
    if (bases.length) {
      type EngineRuntime = Parameters<typeof modelArtifact>[0];
      const found = await withReaderRuntime(reader, ctx.malloyConfig, async (runtime) => {
        const out: Array<{ base: string; artifact: ArtifactInfo }> = [];
        for (const base of bases) {
          const r = await modelArtifact(
            runtime as unknown as EngineRuntime,
            fileUrl(`${dashboardsDir}/${base}.malloy`),
            base,
          );
          if (r.ok && r.artifact) out.push({ base, artifact: r.artifact });
        }
        return out;
      });
      dashboards.push(...found);
    }
  } catch (e) {
    logger.warn("dashboard discovery failed (non-fatal)", {
      datasetId: ds.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // The dashboards' optional flat components, fetched HERE rather than beside
  // the insert — so the write half touches nothing but the database, and no
  // transaction is held open across the network.
  const artifacts: Compiled["artifacts"] = [];
  try {
    for (const { base, artifact: a } of dashboards) {
      let source = "";
      for (const ext of ["jsx", "tsx"]) {
        const path = `${dashboardsDir}/${base}.${ext}`;
        const fromArchive = ctx.archive?.get(path);
        if (fromArchive !== undefined) {
          source = fromArchive;
          break;
        }
        if (ctx.archive) continue; // the archive is the whole repo: it is not there
        // No archive: skip the request when the tree says there is no such file.
        if (treeHas(ctx.tree, path) === false) continue;
        try {
          source = await fetchGitHubFile(owner, repo, branch, path, { useToken });
          break;
        } catch {
          // no component with this extension — try the next / render the default
        }
      }
      artifacts.push({ name: a.name || base, title: a.title, manifest: artifactManifest(base, a), source });
    }
    // The written front door: `dashboards/index.jsx|tsx` with no `index.malloy`.
    // It runs no query, so it is not in `dashboards` above (that loop walks
    // .malloy files) — but it is a real artifact, and the one a reader should
    // land on. Two guards, because there are two ways "index" can already be
    // taken and each misses the other. By FILE: a `dashboards/index.malloy`
    // tagged `name="overview"` publishes as `overview` while index.jsx is its
    // component. By NAME: a tag on some other file can resolve to `index`, and
    // malloy_artifacts has no unique (model_id, name) — two rows would both
    // insert, and getDashboard's unordered `.limit(1)` would then serve whichever
    // Postgres happened to return.
    if (!bases.includes(ABOUT_NAME) && !artifacts.some((r) => r.name === ABOUT_NAME)) {
      for (const ext of ["jsx", "tsx"]) {
        const path = `${dashboardsDir}/${ABOUT_NAME}.${ext}`;
        const fromArchive = ctx.archive?.get(path);
        if (ctx.archive && fromArchive === undefined) continue;
        if (treeHas(ctx.tree, path) === false) continue;
        try {
          const source = fromArchive ?? (await fetchGitHubFile(owner, repo, branch, path, { useToken }));
          artifacts.unshift({
            name: ABOUT_NAME,
            title: ABOUT_TITLE,
            manifest: { title: ABOUT_TITLE },
            source,
          });
          break;
        } catch {
          // no landing page with this extension — try the next, else there is none
        }
      }
    }
  } catch (e) {
    logger.warn("dashboard ingestion failed (non-fatal)", {
      datasetId: ds.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // Re-root at this dataset's own directory, so what is stored is rooted at
  // `index.malloy` exactly as a single-dataset repo's would be. Everything
  // downstream — the MCP query entry, dashboards, drafts — assumes that.
  const rerooted = rerootFiles(reader.fetched, ds.repoDir);
  if (!rerooted.ok) return { ok: false, error: rerooted.error };

  const files = new Map(rerooted.files);
  if (ctx.malloyConfig) files.set("malloy-config.json", ctx.malloyConfig);
  if (ctx.devcontainer) files.set(DEVCONTAINER_PATH, ctx.devcontainer);

  return {
    ok: true,
    compiled: {
      sources: result.sources,
      files,
      artifacts,
      requiredGivens: opts.creating && requirement.required.length > 0 ? requirement.required : null,
      indexContent: rerooted.files.get("index.malloy") ?? "",
    },
  };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Write one compiled dataset. The caller supplies the transaction, which is how
    a repo's datasets land together or not at all. */
async function writeCompiled(
  tx: Tx,
  ds: Pick<Dataset, "id">,
  compiled: Compiled,
  ctx: RepoContext,
): Promise<{ version: number; generatedBy: string; compiledAt: Date | null }> {
  const [latest] = await tx
    .select({ version: malloyModels.version })
    .from(malloyModels)
    .where(eq(malloyModels.datasetId, ds.id))
    .orderBy(desc(malloyModels.createdAt))
    .limit(1);

  const [created] = await tx
    .insert(malloyModels)
    .values({
      datasetId: ds.id,
      version: (latest?.version ?? 0) + 1,
      source: compiled.indexContent,
      generatedBy: `github:${ctx.slug}@${ctx.branch}`,
      compiledAt: new Date(),
      sources: compiled.sources,
      // The same commit on every dataset in the repo. Before this, a
      // GitHub-backed model recorded the branch and never which commit of it, so
      // a repo whose datasets had drifted apart looked exactly like one that had
      // not. Now "they are together" is a fact you can query.
      gitRepo: ctx.slug,
      gitBranch: ctx.branch,
      gitSha: ctx.sha,
    })
    .returning();

  if (compiled.files.size > 0) {
    await tx.insert(malloyModelFiles).values(
      Array.from(compiled.files.entries()).map(([path, content]) => ({
        modelId: created.id,
        path,
        content,
      })),
    );
  }
  if (compiled.artifacts.length > 0) {
    await tx.insert(malloyArtifacts).values(compiled.artifacts.map((a) => ({ ...a, modelId: created.id })));
  }
  if (compiled.requiredGivens) {
    await tx.update(datasets).set({ requiredGivens: compiled.requiredGivens }).where(eq(datasets.id, ds.id));
    logger.info("dataset scoped by its first model", {
      datasetId: ds.id,
      requiredGivens: compiled.requiredGivens,
    });
  }
  return { version: created.version, generatedBy: created.generatedBy, compiledAt: created.compiledAt };
}

export type { RepoContext };

export type RepoRefreshResult = {
  /** Advanced, in this refresh's single transaction, all at `sha`. */
  refreshed: { id: string; name: string; version: number }[];
  /** Failed to compile. When this is non-empty, NOTHING was written. */
  failed: { id: string; name: string; error: string }[];
  /** Rows whose directory the repo no longer has. Left exactly as they were. */
  unpublished: { id: string; name: string; dir: string }[];
  /** Directories the repo publishes that no dataset here covers yet. */
  unclaimed: { name: string; dir: string }[];
  sha: string | null;
};

/**
 * Refresh every dataset a repo publishes, as one unit.
 *
 * Compile them all; only if every one compiled, write them all in one
 * transaction stamped with one commit. A repo that half-lands is the failure
 * this shape exists to prevent — the datasets that landed look healthy, and the
 * one that did not is the one nobody checks.
 */
export async function refreshRepo(
  repoSlug: string,
  branch: string,
): Promise<RepoRefreshResult | { error: string }> {
  const rows = await db
    .select()
    .from(datasets)
    .where(and(eq(datasets.githubRepo, repoSlug), eq(datasets.githubBranch, branch)));
  if (rows.length === 0) return { error: `no datasets are backed by ${repoSlug}@${branch}` };

  const ctx = await repoContext(rows[0]);
  // The archive IS the repo, so the layout comes out of it — no second request
  // to learn a shape we are already holding.
  const layout = ctx.archive
    ? await layoutFromListing(async (path) => archiveEntries(ctx.archive!, path), `${repoSlug}@${branch}`)
    : await discoverRepoLayout(ctx.owner, ctx.repo, branch, { useToken: ctx.useToken, tree: ctx.tree });
  if (!layout.ok) return { error: layout.error };

  // What the repo publishes NOW, keyed by directory. A single-dataset repo
  // publishes one thing at the root, which is `null` in the column.
  const published = new Map<string | null, string>(
    layout.kind === "single" ? [[null, ""]] : layout.datasets.map((d) => [d.dir, d.name] as const),
  );

  const targets = rows.filter((r) => published.has(r.repoDir ?? null));
  // A directory that is gone means the repo no longer publishes that dataset. It
  // is NOT refreshed and NOT touched — the same as a model that stopped exporting
  // a source. Removing a dataset is an admin's decision, never a commit's.
  const unpublished = rows
    .filter((r) => !published.has(r.repoDir ?? null))
    .map((r) => ({ id: r.id, name: r.name, dir: r.repoDir ?? "" }));
  // A directory nothing covers yet: reported, not created. Which datasets exist
  // is a deliberate act needing an owner and a free name, and a webhook has no
  // business choosing either.
  const covered = new Set(targets.map((t) => t.repoDir ?? null));
  const unclaimed = [...published.entries()]
    .filter(([dir]) => !covered.has(dir))
    .map(([dir, name]) => ({ name, dir: dir ?? "" }));

  const compiled: { ds: (typeof rows)[number]; c: Compiled }[] = [];
  const failed: RepoRefreshResult["failed"] = [];
  for (const ds of targets) {
    const r = await compileDataset(ds, ctx);
    if (r.ok) compiled.push({ ds, c: r.compiled });
    else failed.push({ id: ds.id, name: ds.name, error: r.error });
  }

  if (failed.length > 0) {
    // Loud, because nothing else will be: a trigger-driven refusal has no exit
    // code and no reader. Every dataset keeps serving what it already had.
    logger.error("repo refresh refused — nothing was written", {
      repo: repoSlug,
      branch,
      sha: ctx.sha,
      failed,
      held: targets.length - failed.length,
    });
    return { refreshed: [], failed, unpublished, unclaimed, sha: ctx.sha };
  }

  const refreshed: RepoRefreshResult["refreshed"] = [];
  await db.transaction(async (tx) => {
    for (const { ds, c } of compiled) {
      const written = await writeCompiled(tx, ds, c, ctx);
      refreshed.push({ id: ds.id, name: ds.name, version: written.version });
    }
  });

  logger.info("repo refreshed", {
    repo: repoSlug,
    branch,
    sha: ctx.sha,
    refreshed: refreshed.map((r) => r.name),
    unpublished: unpublished.map((u) => u.name),
    unclaimed: unclaimed.map((u) => u.name),
  });
  return { refreshed, failed, unpublished, unclaimed, sha: ctx.sha };
}

/**
 * Refresh ONE dataset from its repo.
 *
 * The creation path. `POST /api/datasets` makes each row and fills it, and there
 * is no repo-wide consistency to keep: the siblings are being created in the same
 * request, and the whole set is rolled back together if any of them fails.
 * Everything AFTER creation goes through `refreshRepo`.
 */
export async function refreshGitHubModel(
  datasetId: string,
  /** `ctx`: a context the caller already built. Creation fills several rows from
      one repo, and building a context per row would download the whole archive
      per dataset — the cost this change exists to remove. */
  opts: { creating?: boolean; ctx?: RepoContext } = {},
): Promise<RefreshResult> {
  const [ds] = await db.select().from(datasets).where(eq(datasets.id, datasetId));
  if (!ds) return { ok: false, error: "dataset not found" };
  if (!ds.githubRepo) return { ok: false, error: "dataset has no github_repo configured" };
  logger.info("refreshGitHubModel start", {
    datasetId,
    repo: ds.githubRepo,
    branch: ds.githubBranch ?? "main",
    repoDir: ds.repoDir,
  });

  const ctx = opts.ctx ?? (await repoContext(ds));
  const r = await compileDataset(ds, ctx, opts);
  if (!r.ok) {
    logger.error("refreshGitHubModel failed", { datasetId, repo: ds.githubRepo, error: r.error });
    return { ok: false, error: r.error };
  }

  const written = await db.transaction((tx) => writeCompiled(tx, ds, r.compiled, ctx));
  logger.info("refreshGitHubModel ok", {
    datasetId,
    repo: ds.githubRepo,
    version: written.version,
    sha: ctx.sha,
    sourceCount: r.compiled.sources.length,
    fileCount: r.compiled.files.size,
    dashboardCount: r.compiled.artifacts.length,
  });
  return {
    ok: true,
    version: written.version,
    generatedBy: written.generatedBy,
    compiledAt: written.compiledAt,
    sources: r.compiled.sources,
    fileCount: r.compiled.files.size,
    dashboardCount: r.compiled.artifacts.length,
  };
}
