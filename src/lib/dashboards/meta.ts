// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// DB-only dashboard helpers — the ONLY dashboard module a Next PAGE may import.
// It reads Postgres to list/resolve stored artifacts and decide custom vs
// tag-only; it does NOT touch Malloy/DuckDB. That boundary is load-bearing: a
// page's SSR render function can't load libduckdb.so (it isn't traceable into
// page bundles — reference_ssr_page_duckdb_500 / PR #80), so anything a page
// imports must be DuckDB-free. The actual query/introspection work lives in
// ./engine (imported only by API routes), and `check-page-no-duckdb` fails the
// build if a page ever reaches the engine's static graph.
//
// This module must NEVER import ./engine or @/lib/malloy (statically or lazily).

import { and, eq, asc, desc } from "drizzle-orm";
import { db, datasets, malloyArtifacts, malloyModelFiles } from "@/db";
import { visibleDatasetWhere, findByDatasetRef, latestModel } from "@/lib/mcp-tools";
import { aboutFirst } from "./about";

export interface DashboardSummary {
  datasetId: string;
  datasetName: string;
  name: string;
  title: string;
  /** The artifact's `#"` doc line, when it has one. Carried on the SUMMARY, not
      just the detail, because the sibling list the frame injects is built from
      summaries — and without it a written page's cards render as bare titles on
      the hosted app while showing their subtitles in dev and in the bundle. */
  description?: string;
}

export interface DashboardDetail extends DashboardSummary {
  manifest: Record<string, unknown>;
  source: string;
  modelId: string;
}

async function artifactsForModel(modelId: string) {
  const rows = await db
    .select()
    .from(malloyArtifacts)
    .where(eq(malloyArtifacts.modelId, modelId))
    .orderBy(asc(malloyArtifacts.name));
  // The About page leads, whatever it sorts as by name — it is the introduction,
  // and the switcher lands on a dataset's first dashboard.
  return aboutFirst(rows);
}

/** One artifact row as a listing entry. The description lives in the manifest,
    so both listings go through here rather than each remembering to read it. */
function summary(
  datasetId: string,
  datasetName: string,
  a: { name: string; title: string | null; manifest: Record<string, unknown> },
): DashboardSummary {
  const description = a.manifest?.description;
  return {
    datasetId,
    datasetName,
    name: a.name,
    title: a.title ?? a.name,
    ...(typeof description === "string" && description ? { description } : {}),
  };
}

/** Dashboards on a single dataset's current (latest) model, if visible. */
export async function listDashboards(userId: string, datasetId: string): Promise<DashboardSummary[]> {
  const found = await findByDatasetRef(userId, datasetId);
  if (!found) return [];
  const rows = await artifactsForModel(found.model.id);
  return rows.map((a) => summary(datasetId, found.ds.name, a));
}

/** Every visible dataset's current dashboards — for the home page. */
export async function listAllDashboards(userId: string): Promise<DashboardSummary[]> {
  const dsList = await db.select().from(datasets).where(visibleDatasetWhere(userId)).orderBy(desc(datasets.createdAt));
  const out: DashboardSummary[] = [];
  for (const ds of dsList) {
    const model = await latestModel(ds.id);
    if (!model) continue;
    const rows = await artifactsForModel(model.id);
    for (const a of rows) out.push(summary(ds.id, ds.name, a));
  }
  return out;
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

/** A dashboard is TAG-ONLY (no custom Dashboard.tsx) iff its stored source is
    empty. Tag-only dashboards render full-width in the trusted page with no
    iframe; a non-empty source is a custom dashboard that runs sandboxed. */
export const isCustomDashboard = (dash: Pick<DashboardDetail, "source">): boolean =>
  (dash.source ?? "").trim().length > 0;

/** A model's malloy-config.json, if it shipped one.
 *
 * The config travels as an ordinary model file — the CLI publish route stores it
 * under that path (api/datasets/[id]/model/push), and the GitHub refresh does the
 * same — so there is no column to add and no migration. Returns the raw text;
 * callers parse what they need (image-hosts.ts, and poolSizeFromConfig's reader
 * in @/lib/malloy, are both shaped that way). */
export async function modelConfigJson(modelId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ content: malloyModelFiles.content })
    .from(malloyModelFiles)
    .where(and(eq(malloyModelFiles.modelId, modelId), eq(malloyModelFiles.path, "malloy-config.json")))
    .limit(1);
  return row?.content;
}
