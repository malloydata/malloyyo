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
  tileIntrospect,
  runRestricted,
  type DashboardGivenSpec,
} from "@malloyyo/mcp-engine";
import { db, datasets, malloyArtifacts } from "@/db";
import { visibleDatasetWhere, findByDatasetRef, latestModel, modelFileMap } from "@/lib/mcp-tools";
import { runNamedMalloyFiles, withModelRuntime, fileUrl } from "@/lib/malloy";

/** Card name for a tile run-expression: the view name from `source -> view`,
    else the query name. */
function tileName(runExpr: string): string {
  const arrow = runExpr.lastIndexOf("->");
  return (arrow >= 0 ? runExpr.slice(arrow + 2) : runExpr).trim();
}

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

/** Run a dashboard. Structure v2: every request compiles against the
    dashboard's OWN file (`manifest.entryFile` = `dashboards/<name>.malloy`),
    not `index.malloy`, so its inline query and imports are in scope. `req`:
    `query` runs a single run-expression (a component's `<Panel query=…>`, and how
    a composite dashboard's grid runs each of its tiles); `malloy` runs restricted
    Malloy text (suggestion queries / ad-hoc panels). Falls back to `index.malloy`
    for a v1 manifest with no `entryFile`. */
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

  const manifest = a.manifest as Record<string, unknown>;
  const entryFile = typeof manifest.entryFile === "string" ? manifest.entryFile : "index.malloy";
  const entry = fileUrl(entryFile);

  if (typeof req.malloy === "string") {
    // Restricted text: core rejects anything outside the model's published
    // surface with 'restricted-construct-forbidden'. The runtime cast bridges
    // the app/engine duplicate @malloydata/malloy installs (same seam as
    // mcp-host.ts) — one runtime object, two identical declaration trees.
    type EngineRuntime = Parameters<typeof runRestricted>[0];
    const out = await withModelRuntime(files, found.model.id, (runtime) =>
      runRestricted(runtime as unknown as EngineRuntime, entry, req.malloy as string, {
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

  // Single run-expression — a custom component's `<Panel query=…>`, one of a
  // composite dashboard's tiles, or a v1 dashboard's stored query. Runs against
  // the dashboard's own entry.
  const runExpr = req.query ?? manifest.query;
  if (typeof runExpr !== "string") return { ok: false, error: "dashboard manifest has no query" };
  try {
    const res = await runNamedMalloyFiles(files, entryFile, runExpr, givens ?? {}, {
      rowLimit: maxRows,
      cacheKey: found.model.id,
    });
    return { ok: true, stableResult: res.stableResult, rows: res.rows, rowCount: res.rowCount };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Per-tile render spec for the independent-grid renderer. */
export interface DashboardTileSpec {
  run: string;
  name: string;
  givens: string[];
  colspan?: number;
  break?: boolean;
  chart?: boolean;
}

export type DashboardTilesResult =
  | { ok: true; tiles: DashboardTileSpec[]; union: DashboardGivenSpec[] }
  | { ok: false; error: string };

/** Per-tile specs + the union of givens for a COMPOSITE dashboard's independent
    grid: each tile carries the given NAMES it references (so the frame runs it
    with only those — binding an unreferenced given fails the compile), and
    `union` is the deduped control set. Mirrors the CLI runner's dashboardTiles. */
export async function dashboardTileSpecs(
  userId: string,
  datasetId: string,
  name: string,
): Promise<DashboardTilesResult> {
  const dash = await getDashboard(userId, datasetId, name);
  if (!dash) return { ok: false, error: "dashboard not found" };
  const found = await findByDatasetRef(userId, datasetId);
  if (!found) return { ok: false, error: "dataset not found" };
  const tiles = Array.isArray(dash.manifest.tiles) ? (dash.manifest.tiles as string[]) : null;
  if (!tiles) return { ok: false, error: "dashboard is not composite" };
  const files = await modelFileMap(found.model);
  const entryFile = typeof dash.manifest.entryFile === "string" ? dash.manifest.entryFile : "index.malloy";
  const entry = fileUrl(entryFile);
  type EngineRuntime = Parameters<typeof tileIntrospect>[0];
  return withModelRuntime(files, found.model.id, async (runtime) => {
    const rt = runtime as unknown as EngineRuntime;
    const byName = new Map<string, DashboardGivenSpec>();
    const out: DashboardTileSpec[] = [];
    for (const tile of tiles) {
      const info = await tileIntrospect(rt, entry, tile);
      const gvs = info.ok ? info.givens : [];
      for (const s of gvs) if (!byName.has(s.name)) byName.set(s.name, s);
      const spec: DashboardTileSpec = { run: tile, name: tileName(tile), givens: gvs.map((s) => s.name) };
      if (info.ok && typeof info.colspan === "number") spec.colspan = info.colspan;
      if (info.ok && info.break) spec.break = true;
      if (info.ok && info.chart) spec.chart = true;
      out.push(spec);
    }
    return { ok: true, tiles: out, union: [...byName.values()] };
  });
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
  const found = await findByDatasetRef(userId, datasetId);
  if (!found) return { ok: false, error: "dataset not found" };
  const files = await modelFileMap(found.model);
  const entryFile = typeof dash.manifest.entryFile === "string" ? dash.manifest.entryFile : "index.malloy";
  const entry = fileUrl(entryFile);
  const tiles = Array.isArray(dash.manifest.tiles) ? (dash.manifest.tiles as string[]) : null;
  type EngineRuntime = Parameters<typeof dashboardGivenSpecs>[0];

  // Composite: the controls are the UNION of givens across the tiles, resolved
  // in the dashboard file's own scope (a given is declared once at model scope).
  if (tiles) {
    return withModelRuntime(files, found.model.id, async (runtime) => {
      const rt = runtime as unknown as EngineRuntime;
      const byName = new Map<string, DashboardGivenSpec>();
      for (const tile of tiles) {
        const specs = await dashboardGivenSpecs(rt, entry, tile);
        if (specs.ok) for (const s of specs.givens) if (!byName.has(s.name)) byName.set(s.name, s);
      }
      return { ok: true, givens: [...byName.values()] };
    });
  }

  // v1: a single stored query.
  const query = dash.manifest.query;
  if (typeof query !== "string") return { ok: false, error: "dashboard manifest has no query" };
  return withModelRuntime(files, found.model.id, (runtime) =>
    dashboardGivenSpecs(runtime as unknown as EngineRuntime, entry, query),
  );
}
