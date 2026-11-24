// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * `POST /api/datasets/:id/model/push` — LEGACY: the repo-less dataset push.
 *
 * Kept only for `malloyyo` binaries installed before `publish --dataset` was
 * removed, so a CI job on an old CLI does not break on a server upgrade. The
 * current CLI never calls it: every publish is a repo (`POST /api/repos/push`),
 * and its first publish adopts a dataset this route created. Nothing new should
 * be built on it; docs/repo-model.md says why it went.
 */

import { NextResponse } from "next/server";
import { classifyCompileError, missingEnvRefs, type FailureKind } from "@/lib/publish-diagnosis";
import { and, desc, eq } from "drizzle-orm";
import { db, datasets, malloyModels, malloyModelFiles, malloyArtifacts, repos } from "@/db";
import { credentialLabel, requireBearer } from "@/lib/bearer-auth";
import { isAdmin } from "@/lib/admin";
import { resolveDatasetByRef } from "@/lib/mcp-tools";
import { introspectModelFiles } from "@/lib/malloy";
import { requirementForPublish } from "@/lib/tenancy";
import { nameToSlug } from "@/lib/slug";
import { logger, serializeErr } from "@/lib/logger";
import { captureTelemetry } from "@/lib/telemetry";

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
interface DashboardPayload {
  name: string;
  manifest: Record<string, unknown>;
  source: string;
}
interface PushBody {
  files?: ModelFile[];
  config?: string;
  git?: GitInfo;
  dashboards?: DashboardPayload[];
}

function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A dataset can only be created under the name the config already targets: the same
// ref has to resolve on every later publish, so we never silently slugify it into
// something else, and a uuid ref has no name to create under.
function creationError(ref: string): string | null {
  if (UUID_RE.test(ref)) {
    return `cannot create dataset "${ref}": --create-dataset needs a name, not a uuid — ` +
      `point the target's "dataset" at the name you want`;
  }
  const slug = nameToSlug(ref);
  if (slug !== ref) {
    return `cannot create dataset "${ref}": dataset names are lowercase letters, digits ` +
      `and underscores — use "${slug}"`;
  }
  return null;
}

function generatedBy(git: GitInfo): string {
  if (!git.repo && !git.sha) return "cli:local";
  const branch = git.branch ?? "?";
  const sha = git.sha ? `#${git.sha.slice(0, 7)}` : "";
  return `cli:${git.repo ?? "?"}@${branch}${sha}`;
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireBearer(req, { scope: "publish" });
  if (!auth.ok) return json(auth.status, { ok: false, error: auth.error });
  // PUBLISHING IS FOR ADMINS — the same single gate as POST /api/repos/push.
  // First, before the dataset is even looked up, so a refusal says nothing
  // about which datasets exist or which repo publishes them.
  if (!isAdmin(auth.user)) {
    return json(403, {
      ok: false,
      kind: "request",
      error: "publishing is admin-only on this instance — ask an admin to publish",
    });
  }

  const { id } = await ctx.params;
  const params = new URL(req.url).searchParams;
  const dryRun = params.get("dryRun") === "1";
  // Publish never auto-creates a dataset (design §4.5): a config typo would otherwise
  // spawn junk datasets. `?create=1` (CLI `--create-dataset`) is the deliberate opt-in,
  // and even then the dataset is only created once the model compiles — a failed push
  // leaves nothing behind.
  const create = params.get("create") === "1";

  // `id` may be a dataset uuid OR a readable ref — so malloy-config.json can
  // target by name instead of a slug. `resolveDatasetByRef` takes a qualified
  // `repo:dataset`, an alias, or a bare name, and REFUSES a bare name two repos
  // both publish rather than picking one. It is not unique per server any more.
  const ds = await resolveDatasetByRef(id);
  if (!ds && !create) {
    return json(404, {
      ok: false,
      kind: "no-dataset",
      error: `dataset "${id}" not found — create it in the UI, or publish with --create-dataset`,
    });
  }
  if (!ds) {
    const bad = creationError(id);
    if (bad) return json(400, { ok: false, kind: "request", error: bad });
  }
  // A dataset a REPO publishes is never written here. This route stores a model
  // with no revision, so writing one would flip a repo dataset between two
  // storage paths on every run — the state the repo model exists to end. It is
  // what an old CLI pinned in CI does after the current CLI adopted the dataset
  // (by name, through the alias adoption leaves). And because that alias makes
  // the name resolve here, it also means no repo-less dataset can be created
  // under a name an adopted one still answers to.
  if (ds?.repoId) {
    const [owner] = await db.select({ slug: repos.slug }).from(repos).where(eq(repos.id, ds.repoId)).limit(1);
    return json(409, {
      ok: false,
      kind: "request",
      error:
        `dataset "${ds.name}" is published by the repo "${owner?.slug ?? "?"}", so it can't be ` +
        `pushed to on its own. Upgrade malloyyo (npm i -g @malloydata/malloyyo) and run ` +
        `\`malloyyo publish\` in that repo.`,
    });
  }
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

  // Build the file map the same way the github path does: model files + malloy-config.json.
  const fileMap = new Map<string, string>(files.map((f) => [f.path, f.content]));
  if (body.config) fileMap.set("malloy-config.json", body.config);

  const result = await introspectModelFiles(fileMap, ENTRY);

  if (!result.ok) {
    const missingEnv = missingEnvRefs(body.config);
    const kind = classifyCompileError(result.error, new Set(fileMap.keys()), missingEnv);
    logger.info("model push rejected", {
      datasetId: ds?.id,
      credential: credentialLabel(auth.cred),
      kind,
      dryRun,
      missingEnv,
      error: result.error,
    });
    // Record the failed attempt on the dataset — but never as a model version (§4.4).
    // Nothing to record when the dataset doesn't exist yet: it isn't created either.
    if (!dryRun && ds) {
      await db
        .update(datasets)
        .set({
          lastPublishAt: new Date(),
          lastPublishSha: git.sha ?? null,
          lastPublishBranch: git.branch ?? null,
          lastPublishError: result.error,
        })
        .where(eq(datasets.id, ds.id));
    }
    if (!dryRun) {
      void captureTelemetry(
        {
          event: "model published",
          properties: {
            method: "cli_push",
            outcome: "error",
            created_dataset: false,
            source_count: 0,
            file_count: files.length,
            dashboard_count: body.dashboards?.length ?? 0,
          },
        },
        auth.user.id,
      );
    }
    return json(400, {
      ok: false,
      kind,
      error: result.error,
      ...(missingEnv.length > 0 ? { missingEnv } : {}),
    });
  }

  // What this dataset is scoped by, after this publish. Refuses a model that
  // drops a requirement the dataset already records — publishing it would
  // return every row to every user (src/lib/tenancy.ts). Decided here, before
  // the dry-run answer and before any write, so a refusal leaves nothing behind.
  // A dataset being CREATED by this publish takes its scoping from this model;
  // an existing one is the authority and the model must satisfy it.
  const requirement = requirementForPublish(ds?.requiredGivens ?? [], result.declaredGivens, {
    creating: !ds,
  });
  if (!requirement.ok) {
    logger.info("model push refused", {
      datasetId: ds?.id,
      credential: credentialLabel(auth.cred),
      error: requirement.error,
    });
    return json(400, { ok: false, kind: "compile" as FailureKind, error: requirement.error });
  }

  if (dryRun) {
    return json(200, {
      ok: true,
      dryRun: true,
      sources: result.sources,
      git,
      ...(requirement.required.length > 0 ? { requiredGivens: requirement.required } : {}),
      ...(ds ? {} : { wouldCreate: true }),
    });
  }

  try {
    const created = await db.transaction(async (tx) => {
      // Created here, not before the compile, so a rejected push leaves no dataset
      // behind — and so the create + first version land in one transaction.
      const target =
        ds ??
        (
          await tx
            .insert(datasets)
            .values({
              userId: auth.user.id,
              name: id,
              // Private by default: visibility is a deliberate act in the UI, never
              // config-driven, and publish never changes it (§4.5).
              isPublic: false,
              status: "ready",
              readyAt: new Date(),
              // Only here: a dataset created by a publish has had no admin to
              // configure it, so the model it was created from sets the list.
              requiredGivens: requirement.required,
            })
            .returning()
        )[0];

      const [latest] = await tx
        .select({ version: malloyModels.version })
        .from(malloyModels)
        .where(eq(malloyModels.datasetId, target.id))
        .orderBy(desc(malloyModels.version), desc(malloyModels.createdAt))
        .limit(1);
      const nextVersion = (latest?.version ?? 0) + 1;

      // THE MODEL A DATASET SERVES IS STATED, NOT ORDERED — and this route has
      // to say so too, or it writes a version nobody serves.
      //
      // `latestModel` asks which row is `active` and only falls back to the
      // newest when none is, so a dataset that HAS an active row (which 0026
      // set for every dataset that existed at migration time) would keep
      // serving it forever while every push here reported a new version
      // number. Silent, permanent, and worse with every publish.
      //
      // Cleared before set, in this transaction: `malloy_models_one_active` is
      // a unique index and Postgres checks it at the end of each statement.
      await tx
        .update(malloyModels)
        .set({ active: false })
        .where(and(eq(malloyModels.datasetId, target.id), eq(malloyModels.active, true)));

      const indexContent = fileMap.get(ENTRY) ?? "";
      const [model] = await tx
        .insert(malloyModels)
        .values({
          datasetId: target.id,
          active: true,
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

      // Dashboards travel with the model — stored per version, same as the
      // GitHub-refresh path. The CLI lints them before sending.
      const dashboards = body.dashboards ?? [];
      if (dashboards.length > 0) {
        await tx.insert(malloyArtifacts).values(
          dashboards.map((d) => ({
            modelId: model.id,
            name: d.name,
            title: typeof d.manifest?.title === "string" ? (d.manifest.title as string) : d.name,
            manifest: d.manifest,
            source: d.source,
          })),
        );
      }

      await tx
        .update(datasets)
        .set({
          lastPublishAt: new Date(),
          lastPublishSha: git.sha ?? null,
          lastPublishBranch: git.branch ?? null,
          lastPublishError: null,
          // The model says what to CALL this dataset — the same `## dataset` tag
          // and `##"` doc string the GitHub and `--repo` paths read. This path
          // already had `result.meta` and ignored it, so a single-dataset
          // publish left the title null while its siblings got theirs.
          title: result.meta.title ?? null,
          description: result.meta.description ?? null,
        })
        .where(eq(datasets.id, target.id));

      return { model, dataset: target };
    });

    logger.info("model push ok", {
      datasetId: created.dataset.id,
      createdDataset: !ds,
      version: created.model.version,
      sourceCount: result.sources.length,
      fileCount: fileMap.size,
      dashboardCount: (body.dashboards ?? []).length,
      generatedBy: created.model.generatedBy,
      credential: credentialLabel(auth.cred),
    });

    void captureTelemetry(
      {
        event: "model published",
        properties: {
          method: "cli_push",
          outcome: "success",
          created_dataset: !ds,
          source_count: result.sources.length,
          file_count: fileMap.size,
          dashboard_count: body.dashboards?.length ?? 0,
        },
      },
      auth.user.id,
    );

    return json(200, {
      ok: true,
      version: created.model.version,
      sources: result.sources,
      // Reported so an author can see the two ways this can be half-configured:
      // what the dataset is scoped by, and what the model declared that nobody
      // asked for — the latter gets no value, so its filter quietly does
      // nothing until an admin ticks the box.
      ...(requirement.required.length > 0 ? { requiredGivens: requirement.required } : {}),
      ...(requirement.declaredButUnused.length > 0
        ? { declaredButUnused: requirement.declaredButUnused }
        : {}),
      compiledAt: created.model.compiledAt,
      git,
      ...(ds ? {} : { created: true, dataset: created.dataset.name, datasetId: created.dataset.id }),
    });
  } catch (err) {
    // Two publishes racing to create the same name: the partial unique index on
    // (name) where status='ready' rejects the loser.
    const msg = err instanceof Error ? err.message : String(err);
    void captureTelemetry(
      {
        event: "model published",
        properties: {
          method: "cli_push",
          outcome: "error",
          created_dataset: false,
          source_count: result.sources.length,
          file_count: fileMap.size,
          dashboard_count: body.dashboards?.length ?? 0,
        },
      },
      auth.user.id,
    );
    if (!ds && /datasets_name_ready_unique|duplicate key/i.test(msg)) {
      logger.info("model push create raced", { dataset: id });
      return json(409, {
        ok: false,
        error: `a dataset named "${id}" was just created by someone else — publish again without --create-dataset`,
      });
    }
    // Say WHAT failed. The model compiled, so this is the database write — and
    // "failed to persist model" with no cause left nothing to act on. The route
    // is admin-only, so the underlying message is fine to return.
    logger.error("model push persist failed", { datasetId: ds?.id ?? null, dataset: id, ...serializeErr(err) });
    return json(500, {
      ok: false,
      kind: "persist",
      error: `the model compiled, but saving it failed: ${msg}`,
    });
  }
}
