// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * ADDING A DATASET TO A REPO FROM A CHAT.
 *
 * The admin-only MCP tools behind it (src/app/mcp/route.ts). Claude edits the
 * repo with GitHub's own MCP server — every write is the person's, in their
 * repo, on a branch — and uses these for what only this instance knows:
 *
 *   listRepos      which repos this instance publishes, their layout, datasets
 *                  and connections (names and kinds, never a secret)
 *   listTables     what a repo's connection can see, before anything is modeled
 *   describeTable  one table's columns, row count and a few rows
 *   checkRepo      a branch, commit or pull request compiled exactly as a publish
 *                  would — stored nowhere, activated never
 *   publishRepo    the refresh that creates the new dataset after the merge
 *
 * ADMIN ONLY, because all of it runs SQL through the repo's connections with
 * this server's credentials, and checkRepo compiles model code nobody has
 * reviewed. That is the power publishing already has (refreshing a repo and
 * creating datasets are admin acts today) reached a new way, not a new power.
 *
 * Exploration reads the repo's LIVE revision, already in this database, rather
 * than GitHub: an instance with no GITHUB_TOKEN has sixty GitHub requests an
 * hour, and looking at tables should not spend them.
 */

import { and, desc, eq } from "drizzle-orm";
import { MalloyError, InMemoryURLReader } from "@malloydata/malloy";
import { jsonRows, layoutFromListing } from "@malloyyo/mcp-engine";
import { db, datasets, repoRevisions, repos, type Repo } from "@/db";
import { fetchGitHubCommitSha, fetchGitHubPullRequest, fetchGitHubZipball, parseGitHubRepo } from "./github";
import { refreshRepo } from "./github-refresh";
import { fileUrl, withConfigConnection, withReaderRuntime } from "./malloy";
import { discardWorkspace, materializeArchive, normalizeArchive } from "./repo-archive";
import { compileDir, localConfigRefusal, type PublishResult } from "./repo-publish";
import { listTablesSql, sqlString } from "./repo-catalog-sql";
import { datasetView, discoverRepoConfig, fsLister, WorkspaceURLReader, writeDatasetWorkspace } from "./repo-workspace";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TABLE_LIMIT = 500;
const SAMPLE_ROWS = 5;
const QUERY_ROWS = 50;

type Fail = { ok: false; error: string };

// ── finding the repo ────────────────────────────────────────────────────────

/** A repo by its slug or its GitHub `owner/name`. */
export async function findRepo(ref: string): Promise<Repo | null> {
  const r = ref.trim();
  const [bySlug] = await db.select().from(repos).where(eq(repos.slug, r)).limit(1);
  if (bySlug) return bySlug;
  const [byGithub] = await db.select().from(repos).where(eq(repos.githubRepo, r)).limit(1);
  return byGithub ?? null;
}

/** The repo's live revision, materialized; null when it has never published. */
async function openLive(repo: Repo): Promise<{ root: string; sha: string | null; revision: number } | null> {
  const [live] = await db
    .select()
    .from(repoRevisions)
    .where(and(eq(repoRevisions.repoId, repo.id), eq(repoRevisions.active, true)))
    .limit(1);
  if (!live) return null;
  return { root: materializeArchive(live.archive, repo.slug), sha: live.gitSha, revision: live.revision };
}

/** Connection names and kinds from a config's text. Never the values. */
function connectionsOf(configText: string | undefined): Array<{ name: string; kind: string }> {
  if (!configText) return [];
  try {
    const parsed = JSON.parse(configText) as { connections?: Record<string, { is?: unknown }> };
    return Object.entries(parsed.connections ?? {}).map(([name, c]) => ({
      name,
      kind: typeof c?.is === "string" ? c.is : "unknown",
    }));
  } catch {
    return [];
  }
}

// ── list_repos ──────────────────────────────────────────────────────────────

export type RepoSummary = {
  repo: string;
  github: string | null;
  branch: string;
  /** "legacy": live datasets, published before repo revisions, so its files aren't stored here yet. */
  layout: "single" | "multi" | "legacy" | "unpublished";
  /** What adding a dataset takes in this repo, in a sentence. */
  addingDatasets: string;
  datasets: Array<{ name: string; dir: string }>;
  connections: Array<{ name: string; kind: string }>;
  liveCommit: string | null;
  /** Branches fetched as previews: the latest snapshot of each. */
  previews: Array<{ branch: string; commit: string | null; fetchedAt: string; ok: boolean }>;
};

export async function listRepos(): Promise<RepoSummary[]> {
  const rows = await db.select().from(repos);
  const out: RepoSummary[] = [];
  for (const repo of rows) {
    const live = await openLive(repo);
    let connections: RepoSummary["connections"] = [];
    let declared: Array<{ name: string; dir: string }> = [];
    let layout: RepoSummary["layout"] = "unpublished";
    if (live) {
      try {
        connections = connectionsOf((await discoverRepoConfig(live.root, "")).text);
        const l = await layoutFromListing(fsLister(live.root), repo.slug);
        if (l.ok) {
          layout = l.kind;
          declared = l.kind === "multi" ? l.datasets.map((d) => ({ name: d.name, dir: d.dir })) : [];
        }
      } finally {
        discardWorkspace(live.root);
      }
    }
    const rowsHere = await db
      .select({ name: datasets.name, dir: datasets.repoDir })
      .from(datasets)
      .where(and(eq(datasets.repoId, repo.id), eq(datasets.status, "ready")));
    if (!live && rowsHere.length > 0) layout = "legacy";
    const snapshots = await db
      .select({
        branch: repoRevisions.gitBranch,
        commit: repoRevisions.gitSha,
        createdAt: repoRevisions.createdAt,
        verified: repoRevisions.verifiedAt,
      })
      .from(repoRevisions)
      .where(and(eq(repoRevisions.repoId, repo.id), eq(repoRevisions.preview, true)))
      .orderBy(desc(repoRevisions.createdAt));
    const previews = new Map<string, RepoSummary["previews"][number]>();
    for (const s of snapshots) {
      if (!s.branch || previews.has(s.branch)) continue;
      previews.set(s.branch, { branch: s.branch, commit: s.commit, fetchedAt: s.createdAt.toISOString(), ok: s.verified !== null });
    }
    out.push({
      repo: repo.slug,
      previews: [...previews.values()],
      github: repo.githubRepo,
      branch: repo.githubBranch ?? "main",
      layout,
      addingDatasets: !repo.githubRepo
        ? "Not attached to GitHub (published with the CLI), so it can't be changed from here."
        : layout === "multi"
          ? `Add datasets/<name>/index.malloy on a branch of ${repo.githubRepo}, then check_repo, merge, publish_repo.`
          : layout === "single"
            ? "A single-dataset repo (index.malloy at its root). A second dataset means restructuring it into datasets/<name>/ first, which this flow doesn't do."
            : layout === "legacy"
              ? "Published before repo revisions, so this instance doesn't hold its files yet. publish_repo once converts it; then its layout and connections show here."
              : "Not published yet.",
      datasets: rowsHere.length ? rowsHere : declared,
      connections,
      liveCommit: live?.sha ?? null,
    });
  }
  return out;
}

// ── list_tables / describe_table ─────────────────────────────────────────────

/** The repo's config (a dataset's own when `dir` has one), from its live revision. */
async function liveConfig(repo: Repo, dir: string): Promise<{ text?: string } | Fail> {
  const live = await openLive(repo);
  if (!live) return { ok: false, error: `${repo.slug} has not published yet, so it has no connections here.` };
  try {
    return await discoverRepoConfig(live.root, dir);
  } finally {
    discardWorkspace(live.root);
  }
}

export type TableList = {
  ok: true;
  connection: string;
  kind: string;
  tables: Array<{ catalog?: string; schema?: string; name: string; type?: string }>;
  truncated: boolean;
  note?: string;
};

export async function listTables(
  repo: Repo,
  connection: string,
  opts: { schema?: string; like?: string; dir?: string } = {},
): Promise<TableList | Fail> {
  if (!IDENT.test(connection)) return { ok: false, error: `"${connection}" is not a connection name.` };
  const cfg = await liveConfig(repo, opts.dir ?? "");
  if ("ok" in cfg) return cfg;
  const known = connectionsOf(cfg.text);
  if (!known.some((c) => c.name === connection)) {
    return {
      ok: false,
      error:
        `${repo.slug} has no connection "${connection}". Its malloy-config.json defines: ` +
        (known.map((c) => `${c.name} (${c.kind})`).join(", ") || "none"),
    };
  }
  try {
    return await withConfigConnection(cfg.text, connection, async (conn) => {
      const sql = listTablesSql(conn.dialectName, opts);
      if (typeof sql !== "string") return sql;
      const res = await conn.runSQL(sql, { rowLimit: TABLE_LIMIT + 1 });
      const rows = res.rows.slice(0, TABLE_LIMIT).map((r) => {
        const v = (k: string) => {
          const hit = Object.entries(r).find(([key]) => key.toLowerCase() === k);
          return hit && hit[1] != null ? String(hit[1]) : undefined;
        };
        return { catalog: v("table_catalog"), schema: v("table_schema"), name: v("table_name") ?? "", type: v("table_type") };
      });
      const out: TableList = {
        ok: true,
        connection,
        kind: conn.dialectName,
        tables: rows,
        truncated: res.rows.length > TABLE_LIMIT,
      };
      if (rows.length === 0 && conn.dialectName === "duckdb") {
        out.note =
          "No tables. A DuckDB connection often reads files instead: describe_table takes a path or URL " +
          "(e.g. 'https://…/orders.parquet' or 'data/orders.csv').";
      }
      return out;
    });
  } catch (err) {
    return { ok: false, error: `could not list tables on ${connection}: ${errText(err)}` };
  }
}

export type TableDescription = {
  ok: true;
  connection: string;
  table: string;
  columns: Array<{ name: string; type: string }>;
  rowCount: number | null;
  sample: Array<Record<string, unknown>>;
};

/** One table — or, on DuckDB, a file path or URL — through Malloy's own `conn.table()`. */
export async function describeTable(
  repo: Repo,
  connection: string,
  table: string,
  opts: { dir?: string } = {},
): Promise<TableDescription | Fail> {
  if (!IDENT.test(connection)) return { ok: false, error: `"${connection}" is not a connection name.` };
  if (!table.trim() || table.includes("\n")) return { ok: false, error: "table must be a name, path or URL." };
  const cfg = await liveConfig(repo, opts.dir ?? "");
  if ("ok" in cfg) return cfg;
  if (!connectionsOf(cfg.text).some((c) => c.name === connection)) {
    return { ok: false, error: `${repo.slug} has no connection "${connection}" (see list_repos).` };
  }
  const entry = fileUrl("describe.malloy");
  const text = `source: t is ${connection}.table(${sqlString(table.trim()).replace(/\\/g, "\\\\")})\n`;
  const reader = new InMemoryURLReader(new Map([[entry.href, text]]));
  try {
    return await withReaderRuntime(reader, cfg.text, async (runtime) => {
      const model = runtime.loadModel(entry);
      const explore = (await model.getModel()).getExploreByName("t");
      const columns = explore.allFields.map((f) => ({
        name: f.name,
        type: f.isAtomicField() ? String(f.type) : f.isExploreField() ? (f.isArray ? "array" : "record") : "view",
      }));
      let rowCount: number | null = null;
      try {
        const counted = await model.loadQuery("run: t -> { aggregate: row_count is count() }").run();
        rowCount = Number((jsonRows(counted)[0] as { row_count?: unknown })?.row_count ?? NaN);
        if (!Number.isFinite(rowCount)) rowCount = null;
      } catch {
        rowCount = null;
      }
      const sample = jsonRows(await model.loadQuery(`run: t -> { select: *; limit: ${SAMPLE_ROWS} }`).run()) as Array<
        Record<string, unknown>
      >;
      return { ok: true, connection, table: table.trim(), columns, rowCount, sample };
    });
  } catch (err) {
    return { ok: false, error: `could not describe ${table} on ${connection}: ${errText(err)}` };
  }
}

// ── check_repo ───────────────────────────────────────────────────────────────

export type DatasetCheck = {
  name: string;
  dir: string;
  /** "new" = no dataset here yet; publish_repo will create it. */
  status: "new" | "existing";
  ok: boolean;
  error?: string;
  sources?: string[];
  dashboards?: string[];
};

export type RepoCheck =
  | {
      ok: true;
      repo: string;
      checked: string;
      commit: string;
      layout: "single" | "multi";
      datasets: DatasetCheck[];
      query?: { dir: string; rows: unknown[]; rowCount: number } | { dir: string; error: string };
      note?: string;
    }
  | Fail;

/** Resolve what to check to a commit SHA: a pull request's test merge, or a branch/tag/SHA. */
async function resolveRef(
  repo: Repo,
  owner: string,
  name: string,
  target: { ref?: string; pr?: number },
): Promise<{ sha: string; label: string; byName?: boolean } | Fail> {
  const useToken = repo.githubUseToken;
  if (target.pr !== undefined) {
    const pr = await fetchGitHubPullRequest(owner, name, target.pr, { useToken });
    if (!pr.ok) return { ok: false, error: `GitHub would not give pull request #${target.pr} (HTTP ${pr.status}).` };
    if (pr.state !== "open") return { ok: false, error: `Pull request #${target.pr} is ${pr.state}.` };
    if (pr.mergeable === false) {
      return {
        ok: false,
        error:
          `Pull request #${target.pr} conflicts with ${pr.baseRef}, so there is no merge result to check. ` +
          `Bring the branch up to date (or redo the change on a fresh branch from ${pr.baseRef}), then check again.`,
      };
    }
    if (!pr.mergeCommitSha) {
      return { ok: false, error: `GitHub is still computing whether #${target.pr} can merge. Try again in a few seconds.` };
    }
    return { sha: pr.mergeCommitSha, label: `pull request #${target.pr} merged into ${pr.baseRef}` };
  }
  const ref = target.ref ?? repo.githubBranch ?? "main";
  if (/^[0-9a-f]{40}$/i.test(ref)) return { sha: ref, label: ref };
  const sha = await fetchGitHubCommitSha(owner, name, ref, { useToken });
  if (!sha) return { ok: false, error: `GitHub has no branch, tag or commit "${ref}" in ${repo.githubRepo}.` };
  return { sha, label: ref, byName: true };
}

export async function checkRepo(
  repo: Repo,
  target: { ref?: string; pr?: number },
  probe?: { dir: string; malloy: string },
): Promise<RepoCheck> {
  if (!repo.githubRepo) return { ok: false, error: `${repo.slug} is not attached to GitHub.` };
  let owner: string;
  let name: string;
  try {
    ({ owner, repo: name } = parseGitHubRepo(repo.githubRepo));
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
  const resolved = await resolveRef(repo, owner, name, target);
  if ("ok" in resolved) return resolved;

  const raw = await fetchGitHubZipball(owner, name, resolved.sha, { useToken: repo.githubUseToken });
  if (!raw) return { ok: false, error: `GitHub would not give ${repo.githubRepo} at ${resolved.sha.slice(0, 12)}.` };
  const archive = await normalizeArchive(raw, { stripWrapper: true });
  const local = localConfigRefusal(archive.entries);
  if (local) return { ok: false, error: local };

  const root = materializeArchive(archive.zip, repo.slug);
  try {
    const layout = await layoutFromListing(fsLister(root), `${repo.githubRepo}@${resolved.label}`);
    if (!layout.ok) return { ok: false, error: layout.error };
    const declared =
      layout.kind === "single" ? [{ name: repo.slug, dir: "" }] : layout.datasets.map((d) => ({ name: d.name, dir: d.dir }));
    const allDirs = declared.map((d) => d.dir);
    const filePaths = archive.entries.filter((e) => !e.isDir).map((e) => e.path);
    const existing = new Set(
      (
        await db
          .select({ dir: datasets.repoDir })
          .from(datasets)
          .where(and(eq(datasets.repoId, repo.id), eq(datasets.status, "ready")))
      ).map((d) => d.dir),
    );

    const results: DatasetCheck[] = [];
    for (const d of declared) {
      const status = existing.has(d.dir) ? "existing" : "new";
      const r = await compileDir(root, d.dir, d.name, allDirs, filePaths);
      results.push(
        r.ok
          ? {
              name: d.name,
              dir: d.dir,
              status,
              ok: true,
              sources: r.compiled.sources.map((s) => s.name),
              dashboards: r.compiled.artifacts.map((a) => a.name),
            }
          : { name: d.name, dir: d.dir, status, ok: false, error: r.error },
      );
    }

    const out: RepoCheck = {
      ok: true,
      repo: repo.slug,
      checked: resolved.label,
      commit: resolved.sha,
      layout: layout.kind,
      datasets: results,
    };
    if (probe) out.query = await runAt(root, probe, allDirs, filePaths);
    // GitHub caches unauthenticated API answers for up to a minute, so a branch
    // name read just after a push can still name the commit before it — and
    // the check would report errors you already fixed. A SHA can't go stale.
    if ("byName" in resolved && resolved.byName) {
      out.note =
        `"${resolved.label}" resolved to ${resolved.sha.slice(0, 12)}. A branch name can lag up to a minute ` +
        `behind a fresh push; to check exactly what you just committed, pass that commit's SHA as \`ref\`.`;
    }
    return out;
  } finally {
    discardWorkspace(root);
  }
}

/** One Malloy query against a dataset of a materialized tree, unrestricted (admin). */
async function runAt(
  root: string,
  probe: { dir: string; malloy: string },
  allDirs: string[],
  filePaths: string[],
): Promise<{ dir: string; rows: unknown[]; rowCount: number } | { dir: string; error: string }> {
  const dir = probe.dir.replace(/^\/+|\/+$/g, "");
  if (!allDirs.includes(dir)) return { dir, error: `no dataset directory "${dir}" at this ref (have: ${allDirs.join(", ") || "the root"}).` };
  const view = datasetView(filePaths, dir, allDirs);
  if ("error" in view) return { dir, error: view.error };
  const config = await discoverRepoConfig(root, dir);
  const ws = writeDatasetWorkspace(root, view, config);
  try {
    return await withReaderRuntime(new WorkspaceURLReader(ws), config.text, async (runtime) => {
      const result = await runtime.loadModel(fileUrl("index.malloy")).loadQuery(probe.malloy).run({ rowLimit: QUERY_ROWS });
      const rows = jsonRows(result);
      return { dir, rows, rowCount: rows.length };
    });
  } catch (err) {
    return { dir, error: errText(err) };
  } finally {
    discardWorkspace(ws);
  }
}

// ── publish_repo ─────────────────────────────────────────────────────────────

/** The refresh that creates datasets: what an admin's "Refresh and create missing datasets" does. */
export async function publishRepo(repo: Repo): Promise<PublishResult> {
  return refreshRepo(repo.id, { createDatasets: true });
}

function errText(err: unknown): string {
  if (err instanceof MalloyError) return err.problems.map((p) => p.message).join("; ") || err.message;
  return err instanceof Error ? err.message : String(err);
}
