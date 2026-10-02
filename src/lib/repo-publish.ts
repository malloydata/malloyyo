// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * STORE → MATERIALIZE → VERIFY → ACTIVATE.
 *
 * One pipeline, for both ways a repo arrives: a `malloyyo publish` and a GitHub
 * push. Not "a GitHub-shaped ingestion and a CLI-shaped one that agree until
 * they do not" — the archive is normalized at the door (src/lib/repo-archive.ts)
 * and everything after it is the same code.
 *
 * THE SHAPE IS THE POINT. The previous design inserted `ready` dataset rows,
 * compiled, and deleted them again if the compile failed. That passes every test
 * you can write against a process that stays alive — and the compile does
 * network I/O and resolves schemas by running SQL, so it is exactly the part a
 * function timeout or a redeploy lands in the middle of. The deletion is a
 * compensating action, and a compensating action only runs if the process
 * survives to run it. What was left behind was `ready` rows with no model,
 * holding their names under a unique index, with nothing on the instance able to
 * release them: the rightful publish afterwards got a permanent 409.
 *
 * So there is nothing to compensate for. The revision row commits FIRST, on its
 * own, and is INERT: nothing reads a revision that is not `active`. A process
 * that dies anywhere between the store and the activation leaves a revision
 * nobody looks at and a repo still serving what it served before. The only
 * mutation that makes a publish visible is the activation transaction, which
 * touches the database and nothing else — no compile, no network, no archive.
 *
 * VERIFICATION IS INLINE. The call does not return until the answer is known:
 * either the revision is live, or the caller is holding the compile errors. A
 * publish that returned "queued" would hand an author an exit code that means
 * nothing, and a CI job that goes green on a repo that never compiled is worse
 * than one that goes red.
 */

import fs from "node:fs";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { modelArtifact, layoutFromListing, type ArtifactInfo } from "@malloyyo/mcp-engine";
import {
  db,
  datasets,
  malloyArtifacts,
  malloyModels,
  repoRevisions,
  repos,
  type Dataset,
  type Repo,
  type RepoRevisionSource,
} from "@/db";
import { ABOUT_NAME, ABOUT_TITLE } from "@/lib/dashboards/about";
import { artifactManifest } from "@/lib/dashboards/manifest";
import { DEVCONTAINER_PATH } from "./github-source-link";
import { logger, serializeErr } from "./logger";
import { fileUrl, introspectModelWithReader, withReaderRuntime, type SourceInfo } from "./malloy";
import {
  ArchiveError,
  discardWorkspace,
  materializeArchive,
  normalizeArchive,
} from "./repo-archive";
import {
  CONFIG_NAMES,
  WorkspaceURLReader,
  datasetView,
  discoverRepoConfig,
  fsLister,
  writeDatasetWorkspace,
} from "./repo-workspace";
import { qualifiedName } from "./repos";
import { requirementForPublish } from "./tenancy";

/** One directory of the repo, compiled. Nothing here has touched the database. */
/**
 * Postgres 23505 — the unique violation `datasets_repo_name_ready_unique` raises.
 *
 * On the SQLSTATE, never the message, which is the server's to localize.
 * drizzle-orm/postgres-js wraps the failure in a `DrizzleQueryError` whose own
 * `code` is undefined and whose `cause` is the `PostgresError` carrying "23505",
 * so both are read: the wrapping is drizzle's business, not ours, and an
 * unwrapped error is what a driver change would hand us.
 *
 * This existed on the old route and was lost when the insert moved inside
 * `activate()` — two publishes planning the same new dataset both compile, and
 * the loser's unique violation became an opaque 500 instead of "another publish
 * claimed that name; re-run".
 */
function isNameClash(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

type CompiledDir = {
  dir: string;
  /** The directory's name as the layout reads it; "" for a root-entry repo. */
  layoutName: string;
  sources: SourceInfo[];
  declaredGivens: string[];
  title: string | null;
  description: string | null;
  indexContent: string;
  artifacts: Array<Omit<typeof malloyArtifacts.$inferInsert, "modelId">>;
  configFrom?: string;
};

export type PublishFailure = { name: string; dir: string; error: string };

export type PublishedDataset = {
  id: string;
  name: string;
  qualified: string;
  dir: string;
  version: number;
  created: boolean;
};

export type PublishResult =
  | {
      ok: true;
      repo: Repo;
      revisionId: string;
      revision: number;
      sha: string | null;
      /** Already live when the call began — identical bytes, nothing to do. */
      unchanged?: true;
      datasets: PublishedDataset[];
      /** Directories the revision publishes that no dataset here covers. */
      unclaimed: Array<{ name: string; dir: string }>;
      /** Live datasets whose directory this revision no longer has. Untouched. */
      unpublished: Array<{ id: string; name: string; dir: string }>;
    }
  | {
      ok: false;
      kind: "archive" | "layout" | "compile" | "request" | "stale" | "clash";
      error: string;
      /** Present once the revision was stored — it is the record of the attempt. */
      revisionId?: string;
      failures?: PublishFailure[];
      /** Directories with no dataset, when that is why the publish was refused. */
      missing?: Array<{ name: string; dir: string }>;
    };

export type PublishInput = {
  repo: Repo;
  /** The archive as received: a zip, or an older CLI's gzipped tar. */
  raw: Buffer;
  source: RepoRevisionSource;
  /** Who published. Null for a webhook, which has no user. */
  createdById: string | null;
  git?: { sha?: string | null; branch?: string | null; dirty?: boolean | null };
  /** May this publish create datasets for directories that have none yet? */
  createDatasets?: boolean;
  /**
   * What to do about a directory the repo publishes that no dataset covers,
   * when `createDatasets` is false.
   *
   * THE TWO CALLERS WANT OPPOSITE THINGS, and collapsing them was a regression
   * I nearly shipped.
   *
   * `"refuse"` is for a CLI publish: someone is reading an exit code, and
   * "pass --create-datasets" is the next thing they should do.
   *
   * `"report"` is for a GitHub refresh, and is the old behaviour. Nobody reads
   * a webhook's exit code — so refusing the whole publish would mean a repo
   * that gained a `datasets/newthing/` directory silently STOPS REFRESHING on
   * every push until an admin notices, which is the opposite of what a trigger
   * should do. The directory is reported as `unclaimed` and the datasets that
   * do exist move on.
   */
  onMissing?: "refuse" | "report";
  /** The owner for datasets this publish creates. Defaults to the repo's owner. */
  datasetOwnerId?: string;
  /**
   * The name for the dataset of a SINGLE-dataset repo (a root `index.malloy`),
   * which has no directory to be named after. Only consulted when the repo has
   * no dataset at its root yet.
   */
  rootDatasetName?: string;
  /**
   * Refuse a repo whose layout is a ROOT `index.malloy` (one dataset).
   *
   * A wire-level decision, not a design one: `malloyyo publish --repo` has
   * always been the multi-dataset flag and `--dataset <name>` the single one,
   * and the server's refusal is what names the right flag when someone reaches
   * it anyway. The pipeline itself handles both layouts, which is what the
   * GitHub path needs — every repo on this instance today is the single shape.
   */
  refuseRootLayout?: boolean;
};

/**
 * The next revision number, taken under a lock on the repo row.
 *
 * Two publishes racing would otherwise both read `max + 1` and one would be
 * rejected by `repo_revisions_repo_revision_unique` — a correct outcome reported
 * as a database error. The lock is held for one insert and no I/O.
 */
async function storeRevision(input: PublishInput, archive: { zip: Buffer; sha256: string }) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from repos where id = ${input.repo.id} for update`);
    const [{ next }] = await tx.execute<{ next: number }>(
      sql`select coalesce(max(revision), 0) + 1 as next from repo_revisions where repo_id = ${input.repo.id}`,
    );
    const [row] = await tx
      .insert(repoRevisions)
      .values({
        repoId: input.repo.id,
        revision: Number(next),
        source: input.source,
        createdById: input.createdById,
        gitSha: input.git?.sha ?? null,
        gitBranch: input.git?.branch ?? null,
        gitDirty: input.git?.dirty ?? null,
        archive: archive.zip,
        archiveBytes: archive.zip.length,
        archiveSha256: archive.sha256,
      })
      .returning();
    return row;
  });
}

/** Record why a stored revision did not go live. It stays, as the record. */
async function recordFailure(revisionId: string, error: string): Promise<void> {
  await db.update(repoRevisions).set({ verifyError: error }).where(eq(repoRevisions.id, revisionId));
}

/**
 * Compile one directory of the materialized repo.
 *
 * The workspace is written first: this dataset's view of the repo on a real
 * disk, with `index.malloy` at its root. The compile then needs nothing but a
 * filesystem reader — which is the whole reason for doing it this way, since
 * every "lint blessed it, the server refused it" bug was an in-memory file map
 * behaving unlike a directory tree.
 */
async function compileDir(
  repoRoot: string,
  dir: string,
  layoutName: string,
  allDirs: string[],
  filePaths: string[],
): Promise<{ ok: true; compiled: CompiledDir } | { ok: false; error: string }> {
  const view = datasetView(filePaths, dir, allDirs);
  if ("error" in view) return { ok: false, error: view.error };

  let config: { text?: string; from?: string };
  try {
    config = await discoverRepoConfig(repoRoot, dir);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const ws = writeDatasetWorkspace(repoRoot, view, config);
  try {
    const reader = new WorkspaceURLReader(ws);
    const result = await introspectModelWithReader(reader, "index.malloy", config.text);
    if (!result.ok) return { ok: false, error: result.error };

    // Structure v2: each `dashboards/<name>.malloy` compiles as its OWN entry.
    // Non-fatal, as before: a broken dashboard must not take the model down,
    // because a dashboard is a view of the data and the data is the point.
    const artifacts: CompiledDir["artifacts"] = [];
    let bases: string[] = [];
    try {
      const dashDir = path.join(ws, "dashboards");
      bases = fs.existsSync(dashDir)
        ? fs
            .readdirSync(dashDir)
            .filter((n) => n.endsWith(".malloy") && fs.statSync(path.join(dashDir, n)).isFile())
            .map((n) => n.slice(0, -".malloy".length))
            .sort()
        : [];
      if (bases.length > 0) {
        type EngineRuntime = Parameters<typeof modelArtifact>[0];
        const found = await withReaderRuntime(reader, config.text, async (runtime) => {
          const out: Array<{ base: string; artifact: ArtifactInfo }> = [];
          for (const base of bases) {
            const r = await modelArtifact(
              runtime as unknown as EngineRuntime,
              fileUrl(`dashboards/${base}.malloy`),
              base,
            );
            if (r.ok && r.artifact) out.push({ base, artifact: r.artifact });
          }
          return out;
        });
        for (const { base, artifact } of found) {
          artifacts.push({
            name: artifact.name || base,
            title: artifact.title,
            manifest: artifactManifest(base, artifact),
            source: componentSource(ws, base),
          });
        }
      }
      // The written front door: `dashboards/index.jsx|tsx` with no
      // `index.malloy`. It runs no query so the loop above never sees it, but it
      // is the page a reader should land on. Two guards, because "index" can be
      // taken by FILE (a `dashboards/index.malloy` tagged `name="overview"`) or
      // by NAME (a tag on another file resolving to `index`) and each misses the
      // other — and `malloy_artifacts` has no unique (model_id, name), so two
      // rows would both insert and an unordered `limit(1)` would pick one.
      if (!bases.includes(ABOUT_NAME) && !artifacts.some((a) => a.name === ABOUT_NAME)) {
        const source = componentSource(ws, ABOUT_NAME);
        if (source) {
          artifacts.unshift({ name: ABOUT_NAME, title: ABOUT_TITLE, manifest: { title: ABOUT_TITLE }, source });
        }
      }
    } catch (err) {
      logger.warn("dashboard discovery failed (non-fatal)", { dir, ...serializeErr(err) });
    }

    return {
      ok: true,
      compiled: {
        dir,
        layoutName,
        sources: result.sources,
        declaredGivens: result.declaredGivens,
        title: result.meta.title ?? null,
        description: result.meta.description ?? null,
        indexContent: fs.readFileSync(path.join(ws, "index.malloy"), "utf8"),
        artifacts,
        configFrom: config.from,
      },
    };
  } finally {
    discardWorkspace(ws);
  }
}

/** A dashboard's optional flat component. ONE lookup, because the two that
    existed before had already drifted in how they short-circuit. */
function componentSource(ws: string, base: string): string {
  for (const ext of ["jsx", "tsx"]) {
    const p = path.join(ws, "dashboards", `${base}.${ext}`);
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  }
  return "";
}

/**
 * Publish a revision of a repo, inline, end to end.
 *
 * Returns only once the revision is live or the reason it is not is in hand.
 */
export async function publishRevision(input: PublishInput): Promise<PublishResult> {
  // ── 1. the bytes ──────────────────────────────────────────────────────────
  let archive;
  try {
    // Only GitHub's archive carries a wrapper directory. Inferring it from the
    // path list ate a multi-dataset repo's own `datasets/` (see
    // `commonRootPrefix`), so the source says.
    archive = await normalizeArchive(input.raw, { stripWrapper: input.source === "github" });
  } catch (err) {
    if (err instanceof ArchiveError) return { ok: false, kind: "archive", error: err.message };
    throw err;
  }

  // A LOCAL CONFIG MUST NOT REACH A SERVER. `malloy-config-local.json` is
  // Malloy's local override: by design it holds real credentials while the
  // shared file holds `{"env": …}` references, and it is normally gitignored.
  // The previous implementation walked the filesystem rather than git, so
  // gitignore did not save it and the file was read off disk and uploaded.
  //
  // Refused rather than ignored. Ignoring it would be a divergence nobody can
  // see — Malloy's own discovery prefers it, so the model would compile against
  // different connections locally than here, which is the exact class of bug
  // this rewrite exists to remove. A refusal names the file.
  const localConfig = archive.entries.find((e) => e.path.split("/").pop() === CONFIG_NAMES[0]);
  if (localConfig) {
    return {
      ok: false,
      kind: "archive",
      error:
        `${localConfig.path} is in the archive. That file is Malloy's LOCAL override — it holds ` +
        `real credentials where the shared malloy-config.json holds {"env": …} references, and it ` +
        `should be gitignored. Remove it from the repo (and rotate anything it held, since it has ` +
        `been committed).`,
    };
  }

  // ── 2. bytes we already serve ─────────────────────────────────────────────
  // A webhook storm, or a re-run of the same publish. Only the ACTIVE revision
  // short-circuits: a revision with these bytes that FAILED verification is
  // re-tried, because the failure may have been a warehouse that was down.
  const [live] = await db
    .select()
    .from(repoRevisions)
    .where(and(eq(repoRevisions.repoId, input.repo.id), eq(repoRevisions.active, true)))
    .limit(1);
  if (live && live.archiveSha256 === archive.sha256) {
    logger.info("repo publish: identical to the live revision", {
      repo: input.repo.slug,
      revision: live.revision,
    });
    const current = await db
      .select()
      .from(datasets)
      .where(and(eq(datasets.repoId, input.repo.id), eq(datasets.status, "ready")));
    return {
      ok: true,
      unchanged: true,
      repo: input.repo,
      revisionId: live.id,
      revision: live.revision,
      sha: live.gitSha,
      datasets: current.map((d) => ({
        id: d.id,
        name: d.name,
        qualified: qualifiedName(input.repo.slug, d.name),
        dir: d.repoDir,
        version: 0,
        created: false,
      })),
      unclaimed: [],
      unpublished: [],
    };
  }

  // ── 3. materialize, and read the shape ────────────────────────────────────
  //
  // BEFORE the store, so a REQUEST error costs nothing durable. A revision is a
  // record of an attempt and its bytes are worth keeping when the CONTENT is at
  // fault — a layout that cannot be published, a model that will not compile.
  // But "you used the wrong flag for this layout" and "that dataset does not
  // exist here yet" are decidable from the layout alone, and a CI loop hitting
  // one of them would otherwise add up to 32MB to `repo_revisions.archive` every
  // run, with nothing pruning it.
  const repoRoot = materializeArchive(archive.zip, input.repo.slug);
  try {
    const filePaths = archive.entries.filter((e) => !e.isDir).map((e) => e.path);
    const shape = await readShape(input, repoRoot);
    if ("refusal" in shape) {
      logger.info("repo publish refused before storing anything", {
        repo: input.repo.slug,
        error: shape.refusal.error,
      });
      return shape.refusal;
    }

    const revision = await storeRevision(input, archive);
    logger.info("repo revision stored", {
      repo: input.repo.slug,
      revision: revision.revision,
      bytes: archive.zip.length,
      entries: archive.entries.length,
      sha: revision.gitSha,
    });

    try {
      return await verifyAndActivate(input, revision, shape, repoRoot, filePaths);
    } catch (err) {
      // An unexpected throw leaves the stored revision unverified and the repo
      // serving what it served. The record of the attempt is already in the
      // database; put the reason there too.
      const msg = err instanceof Error ? err.message : String(err);
      await recordFailure(revision.id, msg).catch(() => {});
      logger.error("repo publish failed", {
        repo: input.repo.slug,
        revision: revision.revision,
        ...serializeErr(err),
      });
      throw err;
    }
  } finally {
    discardWorkspace(repoRoot);
  }
}

/**
 * WHAT THE REPO PUBLISHES, and whether this request may proceed at all.
 *
 * Cheap and first: a filesystem walk and one SELECT. Everything it can refuse
 * is a request error, so refusing here costs no stored archive — see the note in
 * `publishRevision`. A LAYOUT problem is content, not request, so it is carried
 * out as `layoutError` and recorded against the revision by the caller.
 */
type Shape = {
  declared: Array<{ name: string; dir: string }>;
  live: Dataset[];
  byDir: Map<string, Dataset[]>;
  /** Directories the repo publishes that no dataset here covers. */
  unclaimed: Array<{ name: string; dir: string }>;
  /** Live datasets whose directory the repo no longer has. */
  unpublished: Array<{ id: string; name: string; dir: string }>;
  /** The directories to compile: covered, or being created. */
  toCompile: Array<{ name: string; dir: string }>;
  /** Set when the layout rules refused. Nothing else in here is meaningful. */
  layoutError?: string;
};

async function readShape(
  input: PublishInput,
  repoRoot: string,
): Promise<Shape | { refusal: PublishResult & { ok: false } }> {
  const label = input.repo.githubRepo
    ? `${input.repo.githubRepo}@${input.repo.githubBranch ?? "main"}`
    : input.repo.slug;
  const empty: Shape = {
    declared: [],
    live: [],
    byDir: new Map(),
    unclaimed: [],
    unpublished: [],
    toCompile: [],
  };

  // GIT DECIDED what is in the archive; the LAYOUT RULES decide what it
  // publishes, and they run over the materialized tree through the same
  // injected-lister interface `malloyyo lint` uses on the author's disk.
  //
  // NO SKIP LIST ON THIS SIDE, and that is the honest scope of the claim: the
  // server reads what the archive holds, and for a GitHub pull the archive is
  // the zipball, which is git's own answer. The CLI still walks a filesystem
  // with an extension allowlist (packages/cli/src/gather.ts), so a dataset
  // directory holding only unlisted file types still arrives thin from that
  // side. The specific bug is dead — the list that named `docs` counted a
  // dataset legitimately called `datasets/docs/` and packed it with none of its
  // files — but the mechanism is not, and saying "there is no skip list" of
  // both halves would be the kind of false invariant comment that stops the
  // next reader checking.
  const layout = await layoutFromListing(fsLister(repoRoot), label);
  if (!layout.ok) return { ...empty, layoutError: layout.error };

  if (layout.kind === "single" && input.refuseRootLayout) {
    return {
      refusal: {
        ok: false,
        kind: "request",
        error:
          `${label} publishes a single dataset (index.malloy at its root), so it has no name of ` +
          `its own here. Publish it with --dataset <name> instead.`,
      },
    };
  }

  const declared =
    layout.kind === "single"
      ? [{ name: "", dir: "" }]
      : layout.datasets.map((d) => ({ name: d.name, dir: d.dir }));

  // MEMBERSHIP IS THE FOREIGN KEY AND THE STATUS. Not a match on two text
  // columns with no status filter, which against the production fork matched
  // seven rows for one repo, none of them live — so one webhook push compiled
  // the same model seven times and wrote seven versions nobody could see.
  const live = await db
    .select()
    .from(datasets)
    .where(and(eq(datasets.repoId, input.repo.id), eq(datasets.status, "ready")));
  const byDir = new Map<string, Dataset[]>();
  for (const d of live) byDir.set(d.repoDir, [...(byDir.get(d.repoDir) ?? []), d]);

  const missing = declared.filter((d) => !byDir.has(d.dir));
  if (missing.length > 0 && !input.createDatasets && (input.onMissing ?? "report") === "refuse") {
    const names = missing.map((m) => m.name || (input.rootDatasetName ?? input.repo.slug));
    return {
      refusal: {
        ok: false,
        kind: "request",
        error:
          `${names.join(", ")}: not on this instance yet. ` +
          `Pass --create-datasets to create ${missing.length > 1 ? "them" : "it"}.`,
        missing: missing.map((m, i) => ({ name: names[i], dir: m.dir })),
      },
    };
  }

  return {
    declared,
    live,
    byDir,
    // Reported, not created. Which datasets exist is a deliberate act needing an
    // owner and a free name, and a webhook has no business choosing either — but
    // neither does it get to stop the repo refreshing over it.
    unclaimed: input.createDatasets
      ? []
      : missing.map((m) => ({ name: m.name || input.repo.slug, dir: m.dir })),
    // A directory that is GONE means the repo stopped publishing that dataset.
    // It is not refreshed and not touched: saved queries, share links and
    // history pointing at it are somebody's work, and a commit is not a
    // decision to throw that away.
    unpublished: live
      .filter((d) => !declared.some((x) => x.dir === d.repoDir))
      .map((d) => ({ id: d.id, name: d.name, dir: d.repoDir })),
    toCompile: declared.filter((d) => input.createDatasets || byDir.has(d.dir)),
  };
}

async function verifyAndActivate(
  input: PublishInput,
  revision: typeof repoRevisions.$inferSelect,
  shape: Shape,
  repoRoot: string,
  filePaths: string[],
): Promise<PublishResult> {
  // ── 4. the shape, recorded ────────────────────────────────────────────────
  if (shape.layoutError) {
    await recordFailure(revision.id, shape.layoutError);
    return { ok: false, kind: "layout", error: shape.layoutError, revisionId: revision.id };
  }

  const { declared, live, byDir, unclaimed, unpublished, toCompile } = shape;
  const allDirs = declared.map((d) => d.dir);

  await db
    .update(repoRevisions)
    .set({
      datasets: declared,
      hasDevcontainer: filePaths.includes(DEVCONTAINER_PATH),
    })
    .where(eq(repoRevisions.id, revision.id));

  // ── 5. compile ────────────────────────────────────────────────────────────
  // THE UNIT OF COMPILE IS A DIRECTORY, the unit of write a dataset. Two
  // datasets may legitimately share a directory — same model, different
  // `required_givens` and roles — and compiling once for both is both cheaper
  // and the only way they are guaranteed to be the same model.
  const compiled: CompiledDir[] = [];
  const failures: PublishFailure[] = [];
  for (const d of toCompile) {
    const r = await compileDir(repoRoot, d.dir, d.name, allDirs, filePaths);
    if (r.ok) compiled.push(r.compiled);
    else failures.push({ name: d.name || input.repo.slug, dir: d.dir, error: r.error });
  }

  // What each dataset will be scoped by. A REFRESH never widens it: the
  // dataset's list wins and a model that stopped declaring one is refused rather
  // than quietly serving unscoped. Only a dataset being CREATED takes its
  // requirement from the model, because no admin has had a chance to tick
  // anything yet.
  const plans: Array<{
    dataset: Dataset | null;
    create?: { name: string; dir: string };
    compiled: CompiledDir;
    requiredGivens: string[] | null;
  }> = [];
  for (const c of compiled) {
    const existing = byDir.get(c.dir) ?? [];
    if (existing.length === 0) {
      const name = c.layoutName || input.rootDatasetName || input.repo.slug;
      const req = requirementForPublish([], c.declaredGivens, { creating: true });
      if (!req.ok) {
        failures.push({ name, dir: c.dir, error: req.error });
        continue;
      }
      plans.push({ dataset: null, create: { name, dir: c.dir }, compiled: c, requiredGivens: req.required });
      continue;
    }
    for (const ds of existing) {
      const req = requirementForPublish(ds.requiredGivens ?? [], c.declaredGivens, {});
      if (!req.ok) {
        failures.push({ name: ds.name, dir: c.dir, error: req.error });
        continue;
      }
      plans.push({ dataset: ds, compiled: c, requiredGivens: null });
    }
  }

  if (failures.length > 0) {
    const error = failures.map((f) => `${f.name}: ${f.error}`).join("; ");
    await recordFailure(revision.id, error);
    // Loud, because a trigger-driven refusal has no exit code and no reader.
    logger.error("repo revision refused — nothing was activated", {
      repo: input.repo.slug,
      revision: revision.revision,
      sha: revision.gitSha,
      failures,
      stillServing: live.length,
    });
    return { ok: false, kind: "compile", error, revisionId: revision.id, failures };
  }

  // ── 6. activate ───────────────────────────────────────────────────────────
  const activated = await activate(input, revision, plans);
  if (!activated.ok) return activated;

  if (unclaimed.length > 0) {
    logger.warn("repo publishes directories no dataset covers — add them to create them", {
      repo: input.repo.slug,
      revision: revision.revision,
      unclaimed: unclaimed.map((u) => u.dir),
    });
  }

  logger.info("repo revision live", {
    repo: input.repo.slug,
    revision: revision.revision,
    sha: revision.gitSha,
    datasets: activated.datasets.map((d) => d.qualified),
    unpublished: unpublished.map((u) => u.name),
  });

  return {
    ok: true,
    repo: input.repo,
    revisionId: revision.id,
    revision: revision.revision,
    sha: revision.gitSha,
    datasets: activated.datasets,
    unclaimed,
    unpublished,
  };
}

/**
 * THE ONE MUTATION THAT MAKES A PUBLISH VISIBLE.
 *
 * Pure database work: no compile, no network, no archive. Everything slow or
 * fallible already happened, and its result is in memory. So the transaction is
 * short, and "the repo's datasets move together or not at all" costs nothing to
 * guarantee.
 *
 * ACTIVATION NEVER MOVES A REPO BACKWARDS. Two publishes can verify
 * concurrently — they are independent and both may succeed — and without this a
 * slower, older one could land last and quietly replace the newer. The repo row
 * is locked, the live revision is compared, and an older one steps aside.
 */
async function activate(
  input: PublishInput,
  revision: typeof repoRevisions.$inferSelect,
  plans: Array<{
    dataset: Dataset | null;
    create?: { name: string; dir: string };
    compiled: CompiledDir;
    requiredGivens: string[] | null;
  }>,
): Promise<{ ok: true; datasets: PublishedDataset[] } | (PublishResult & { ok: false })> {
  const ownerId = input.datasetOwnerId ?? input.repo.ownerId;
  const now = new Date();

  try {
    const out = await db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from repos where id = ${input.repo.id} for update`);
      const [live] = await tx
        .select({ id: repoRevisions.id, revision: repoRevisions.revision })
        .from(repoRevisions)
        .where(and(eq(repoRevisions.repoId, input.repo.id), eq(repoRevisions.active, true)))
        .limit(1);
      if (live && live.revision > revision.revision) {
        return { stale: live.revision as number };
      }

      const published: PublishedDataset[] = [];
      for (const plan of plans) {
        let target = plan.dataset;
        if (!target) {
          const [row] = await tx
            .insert(datasets)
            .values({
              userId: ownerId,
              repoId: input.repo.id,
              repoDir: plan.create!.dir,
              name: plan.create!.name,
              // Private by default: visibility is a deliberate act in the UI,
              // never config-driven, and a publish never changes it.
              isPublic: false,
              // Honest, because the row and its first model version commit
              // together — there is no instant at which this dataset exists
              // without one.
              status: "ready",
              readyAt: now,
              requiredGivens: plan.requiredGivens ?? [],
            })
            .returning();
          target = row;
        }

        const [{ next }] = await tx.execute<{ next: number }>(
          sql`select coalesce(max(version), 0) + 1 as next from malloy_models where dataset_id = ${target.id}`,
        );
        // Clear before set: `malloy_models_one_active` is a unique index, and
        // Postgres checks it at the end of each statement.
        await tx
          .update(malloyModels)
          .set({ active: false })
          .where(and(eq(malloyModels.datasetId, target.id), eq(malloyModels.active, true)));
        const [model] = await tx
          .insert(malloyModels)
          .values({
            datasetId: target.id,
            revisionId: revision.id,
            active: true,
            version: Number(next),
            source: plan.compiled.indexContent,
            generatedBy:
              revision.source === "github"
                ? `github:${input.repo.githubRepo}@${input.repo.githubBranch ?? "main"}`
                : `cli:${input.repo.slug}`,
            compiledAt: now,
            sources: plan.compiled.sources,
            // Denormalized from the revision on purpose: it is immutable
            // per-model provenance written in this transaction, not mutable
            // repo-level config resolved by row order, which is the thing the
            // rewrite moved onto `repos`.
            gitRepo: input.repo.githubRepo ?? null,
            gitBranch: revision.gitBranch,
            gitSha: revision.gitSha,
            gitDirty: revision.gitDirty,
          })
          .returning();

        if (plan.compiled.artifacts.length > 0) {
          await tx
            .insert(malloyArtifacts)
            .values(plan.compiled.artifacts.map((a) => ({ ...a, modelId: model.id })));
        }

        await tx
          .update(datasets)
          .set({
            // The title and description follow the model on EVERY publish:
            // they are labels, so changing them in the model is the way to
            // change them, and cleared when the tag goes so the derived title
            // takes over again.
            title: plan.compiled.title,
            description: plan.compiled.description,
            lastPublishAt: now,
            lastPublishSha: revision.gitSha,
            lastPublishBranch: revision.gitBranch,
            lastPublishError: null,
          })
          .where(eq(datasets.id, target.id));

        published.push({
          id: target.id,
          name: target.name,
          qualified: qualifiedName(input.repo.slug, target.name),
          dir: target.repoDir,
          version: Number(next),
          created: !plan.dataset,
        });
      }

      // The pointer flip. One statement each, same transaction, so no reader
      // ever sees two live revisions or none.
      if (live) {
        await tx.update(repoRevisions).set({ active: false }).where(eq(repoRevisions.id, live.id));
      }
      await tx
        .update(repoRevisions)
        .set({ active: true, activatedAt: now, verifiedAt: now, verifyError: null })
        .where(eq(repoRevisions.id, revision.id));
      await tx.update(repos).set({ updatedAt: now }).where(eq(repos.id, input.repo.id));

      return { published };
    });

    if ("stale" in out) {
      const error =
        `revision ${revision.revision} verified, but revision ${out.stale} is already live — ` +
        `a newer publish won the race, so this one was not activated`;
      await recordFailure(revision.id, error);
      logger.warn("repo revision not activated (older than live)", {
        repo: input.repo.slug,
        revision: revision.revision,
        live: out.stale,
      });
      return { ok: false, kind: "stale", error, revisionId: revision.id };
    }
    return { ok: true, datasets: out.published };
  } catch (err) {
    // Nothing partial survives: every write above is in the one transaction. The
    // revision stays, unverified, as the record of the attempt.
    const msg = err instanceof Error ? err.message : String(err);
    await recordFailure(revision.id, msg).catch(() => {});
    if (isNameClash(err)) {
      const names = plans
        .filter((p) => p.create)
        .map((p) => `"${p.create!.name}"`)
        .join(", ");
      return {
        ok: false,
        kind: "clash",
        error:
          `another publish claimed ${names || "a dataset name"} in this repo first — ` +
          `nothing was activated; re-run to see which names are still free`,
        revisionId: revision.id,
      };
    }
    throw err;
  }
}
