// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Server-side dashboard helpers: list/resolve stored artifacts (viewer-scoped),
// introspect the given specs a dashboard's query needs (from the MODEL's given:
// declarations — the single source of truth), and run its queries. Governance:
// a dashboard may run (a) any named query the model publishes, or (b) restricted
// Malloy text — core's restricted mode (no import / given: / connection.* / raw
// SQL / ##! flags) is the gate, the same contract the explore MCP surface uses.

import { and, eq, asc, desc } from "drizzle-orm";
import {
  dashboardGivenSpecs,
  runRestricted,
  type DashboardGivenSpec,
} from "@malloyyo/mcp-engine";
import { db, datasets, malloyArtifacts } from "@/db";
import { visibleDatasetWhere, findByDatasetRef, latestModel, modelFileMap } from "@/lib/mcp-tools";
import { runNamedMalloyFiles, withModelRuntime, fileUrl } from "@/lib/malloy";

export interface DashboardSummary {
  datasetId: string;
  datasetName: string;
  name: string;
  title: string;
}

async function artifactsForModel(modelId: string) {
  return db
    .select()
    .from(malloyArtifacts)
    .where(eq(malloyArtifacts.modelId, modelId))
    .orderBy(asc(malloyArtifacts.name));
}

/** Dashboards on a single dataset's current (latest) model, if visible. */
export async function listDashboards(userId: string, datasetId: string): Promise<DashboardSummary[]> {
  const found = await findByDatasetRef(userId, datasetId);
  if (!found) return [];
  const rows = await artifactsForModel(found.model.id);
  return rows.map((a) => ({ datasetId, datasetName: found.ds.name, name: a.name, title: a.title ?? a.name }));
}

/** Every visible dataset's current dashboards — for the home page. */
export async function listAllDashboards(userId: string): Promise<DashboardSummary[]> {
  const dsList = await db.select().from(datasets).where(visibleDatasetWhere(userId)).orderBy(desc(datasets.createdAt));
  const out: DashboardSummary[] = [];
  for (const ds of dsList) {
    const model = await latestModel(ds.id);
    if (!model) continue;
    const rows = await artifactsForModel(model.id);
    for (const a of rows) out.push({ datasetId: ds.id, datasetName: ds.name, name: a.name, title: a.title ?? a.name });
  }
  return out;
}

export interface DashboardDetail extends DashboardSummary {
  manifest: Record<string, unknown>;
  source: string;
  modelId: string;
}

export async function getDashboard(userId: string, datasetId: string, name: string): Promise<DashboardDetail | null> {
  const found = await findByDatasetRef(userId, datasetId);
  if (!found) return null;
  const [a] = await db
    .select()
    .from(malloyArtifacts)
    .where(and(eq(malloyArtifacts.modelId, found.model.id), eq(malloyArtifacts.name, name)))
    .limit(1);
  if (!a) return null;
  return {
    datasetId,
    datasetName: found.ds.name,
    name: a.name,
    title: a.title ?? a.name,
    manifest: a.manifest,
    source: a.source,
    modelId: found.model.id,
  };
}

export type DashboardRunResult =
  | { ok: true; stableResult: unknown; rows?: unknown[]; rowCount: number }
  | { ok: false; error: string };

/** Run a dashboard query: `req.query` is a run-expression (a query name or a
    `<source> -> <view>` path; defaults to the stored manifest's), `req.malloy`
    runs restricted Malloy text instead — the path suggestion queries and
    ad-hoc panels use. */
export async function runDashboard(
  userId: string,
  datasetId: string,
  name: string,
  req: { query?: string; malloy?: string },
  givens: Record<string, unknown>,
  maxRows = 5000,
): Promise<DashboardRunResult> {
  const found = await findByDatasetRef(userId, datasetId);
  if (!found) return { ok: false, error: "dataset not found" };
  if (found.ds.status !== "ready") return { ok: false, error: "dataset not ready" };
  const [a] = await db
    .select()
    .from(malloyArtifacts)
    .where(and(eq(malloyArtifacts.modelId, found.model.id), eq(malloyArtifacts.name, name)))
    .limit(1);
  if (!a) return { ok: false, error: `dashboard '${name}' not found` };
  const files = await modelFileMap(found.model);

  if (typeof req.malloy === "string") {
    // Restricted text: core rejects anything outside the model's published
    // surface with 'restricted-construct-forbidden'. The runtime cast bridges
    // the app/engine duplicate @malloydata/malloy installs (same seam as
    // mcp-host.ts) — one runtime object, two identical declaration trees.
    type EngineRuntime = Parameters<typeof runRestricted>[0];
    const out = await withModelRuntime(files, found.model.id, (runtime) =>
      runRestricted(runtime as unknown as EngineRuntime, fileUrl("index.malloy"), req.malloy as string, {
        givens: givens ?? {},
        stableResult: true,
        rowLimit: maxRows,
      }),
    );
    if (!out.ok) {
      const msg = (out.problems ?? []).map((p) => p.message).join("; ");
      return { ok: false, error: msg || "query failed" };
    }
    return { ok: true, stableResult: out.stable_result, rows: out.rows, rowCount: out.row_count ?? 0 };
  }

  const runExpr = req.query ?? (a.manifest as Record<string, unknown>).query;
  if (typeof runExpr !== "string") return { ok: false, error: "dashboard manifest has no query" };
  try {
    const res = await runNamedMalloyFiles(files, "index.malloy", runExpr, givens ?? {}, {
      rowLimit: maxRows,
      cacheKey: found.model.id,
    });
    return { ok: true, stableResult: res.stableResult, rows: res.rows, rowCount: res.rowCount };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export type DashboardGivensResult =
  | { ok: true; givens: DashboardGivenSpec[] }
  | { ok: false; error: string };

/** The given specs a dashboard's primary query needs — introspected from the
    model's given: declarations (types, defaults, doc comments, # tags). The
    frame route injects these so the sandboxed runtime builds its controls
    without the manifest redeclaring anything. */
export async function dashboardGivens(
  userId: string,
  datasetId: string,
  name: string,
): Promise<DashboardGivensResult> {
  const dash = await getDashboard(userId, datasetId, name);
  if (!dash) return { ok: false, error: "dashboard not found" };
  const query = dash.manifest.query;
  if (typeof query !== "string") return { ok: false, error: "dashboard manifest has no query" };
  const found = await findByDatasetRef(userId, datasetId);
  if (!found) return { ok: false, error: "dataset not found" };
  const files = await modelFileMap(found.model);
  type EngineRuntime = Parameters<typeof dashboardGivenSpecs>[0];
  return withModelRuntime(files, found.model.id, (runtime) =>
    dashboardGivenSpecs(runtime as unknown as EngineRuntime, fileUrl("index.malloy"), query),
  );
}
