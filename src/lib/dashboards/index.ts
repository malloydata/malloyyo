// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Server-side dashboard helpers: list/resolve stored artifacts (viewer-scoped)
// and run a dashboard's declared query with given values. Governance: the query
// is taken from the STORED manifest, never from the client — the client only
// supplies given (filter) values.

import { and, eq, asc, desc } from "drizzle-orm";
import { db, datasets, malloyArtifacts } from "@/db";
import { visibleDatasetWhere, findByDatasetRef, latestModel, modelFileMap } from "@/lib/mcp-tools";
import { runNamedMalloyFiles } from "@/lib/malloy";

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
  | { ok: true; stableResult: unknown; rowCount: number }
  | { ok: false; error: string };

/** Run the dashboard's declared query with the given filter values. */
export async function runDashboard(
  userId: string,
  datasetId: string,
  name: string,
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
  const query = (a.manifest as Record<string, unknown>).query;
  if (typeof query !== "string") return { ok: false, error: "dashboard manifest has no query" };
  const files = await modelFileMap(found.model);
  try {
    const res = await runNamedMalloyFiles(files, "index.malloy", query, givens ?? {}, {
      rowLimit: maxRows,
      cacheKey: found.model.id,
    });
    return { ok: true, stableResult: res.stableResult, rowCount: res.rowCount };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
