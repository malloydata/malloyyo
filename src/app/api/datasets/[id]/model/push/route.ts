// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db, datasets, malloyModels, malloyModelFiles, malloyArtifacts } from "@/db";
import { requireAdminBearer } from "@/lib/bearer-auth";
import { resolveDatasetByRef } from "@/lib/mcp-tools";
import { introspectModelFiles } from "@/lib/malloy";
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

type FailureKind = "missing-import" | "connection" | "compile";

// Best-effort: an unresolved import surfaces as an error mentioning a file URL that
// isn't in the uploaded set; a connection problem names the connection or fails at
// connect time. The CLI turns `kind` into a next step — "which file didn't upload"
// and "which secret isn't set here" are very different fixes from "fix the Malloy".
function classifyCompileError(error: string, paths: Set<string>, missingEnv: string[]): FailureKind {
  for (const m of error.matchAll(/file:\/\/\/([^\s'"]+)/g)) {
    if (!paths.has(m[1])) return "missing-import";
  }
  if (missingEnv.length > 0) return "connection";
  if (/No connection named|Invalid SQL, (connect |getaddrinfo|Error: connect)/i.test(error)) {
    return "connection";
  }
  return "compile";
}

/**
 * Env vars that malloy-config.json references as `{"env": "NAME"}` but that
 * aren't set HERE. Malloy resolves a missing one to empty rather than failing,
 * so the symptom is a baffling connection error ("connect ECONNREFUSED",
 * "password authentication failed") with no mention of the secret. The config
 * ships from the repo but the values are per-deployment, so this is the single
 * likeliest reason a model that works locally fails on publish.
 *
 * The CLI runs the same check against its own shell before sending
 * (packages/cli/src/shared/env-refs.ts) — separate package, so it's duplicated.
 */
function missingEnvRefs(configJson: string | undefined): string[] {
  if (!configJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    return []; // Malloy will report the bad JSON itself.
  }
  const missing = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return void node.forEach(walk);
    if (typeof node !== "object" || node === null) return;
    const rec = node as Record<string, unknown>;
    if (typeof rec.env === "string" && !process.env[rec.env]) missing.add(rec.env);
    for (const v of Object.values(rec)) walk(v);
  };
  walk(parsed);
  return [...missing];
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
  const auth = await requireAdminBearer(req);
  if (!auth.ok) return json(auth.status, { ok: false, error: auth.error });

  const { id } = await ctx.params;
  const params = new URL(req.url).searchParams;
  const dryRun = params.get("dryRun") === "1";
  // Publish never auto-creates a dataset (design §4.5): a config typo would otherwise
  // spawn junk datasets. `?create=1` (CLI `--create-dataset`) is the deliberate opt-in,
  // and even then the dataset is only created once the model compiles — a failed push
  // leaves nothing behind.
  const create = params.get("create") === "1";

  // `id` may be a dataset uuid OR a readable name (the ready dataset with that name,
  // unique per server) — so malloy-config.json can target by name instead of a slug.
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
    logger.info("model push rejected", { datasetId: ds?.id, kind, dryRun, missingEnv, error: result.error });
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

  if (dryRun) {
    return json(200, { ok: true, dryRun: true, sources: result.sources, git, ...(ds ? {} : { wouldCreate: true }) });
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
            })
            .returning()
        )[0];

      const [latest] = await tx
        .select({ version: malloyModels.version })
        .from(malloyModels)
        .where(eq(malloyModels.datasetId, target.id))
        .orderBy(desc(malloyModels.createdAt))
        .limit(1);
      const nextVersion = (latest?.version ?? 0) + 1;

      const indexContent = fileMap.get(ENTRY) ?? "";
      const [model] = await tx
        .insert(malloyModels)
        .values({
          datasetId: target.id,
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
