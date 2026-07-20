// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Dashboard query + introspection — the Malloy/DuckDB half. Import this ONLY
// from API routes (route.ts handlers): it statically imports @/lib/malloy →
// @duckdb/node-api, which loads libduckdb.so at eval time. That's fine in a
// route handler (its function bundles the native lib via outputFileTracingIncludes)
// but fatal in a page's SSR render function (which can't — see ./meta and
// reference_ssr_page_duckdb_500). The `check-page-no-duckdb` preflight step fails
// the build if a page ever reaches this module's static graph, so the boundary
// can't silently rot back into a prod 500.
//
// Governance: a dashboard may run (a) any named query the model publishes, or
// (b) restricted Malloy text — core's restricted mode (no import / given: /
// connection.* / raw SQL / ##! flags) is the gate, the same contract the explore
// MCP surface uses.

import { and, eq } from "drizzle-orm";
import { dashboardGivenSpecs, runRestricted, type DashboardGivenSpec } from "@malloyyo/mcp-engine";
import { db, malloyArtifacts } from "@/db";
import { findByDatasetRef, modelFileMap } from "@/lib/mcp-tools";
import { runNamedMalloyFiles, withModelRuntime, fileUrl } from "@/lib/malloy";
import { getDashboard, type DashboardDetail } from "./meta";

export type { DashboardDetail };

/** Card name for a tile run-expression: the view name from `source -> view`,
    else the query name. */
function tileName(runExpr: string): string {
  const arrow = runExpr.lastIndexOf("->");
  return (arrow >= 0 ? runExpr.slice(arrow + 2) : runExpr).trim();
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

/** Per-tile spec the frame's renderer needs: run-expression, card name, and the
    given NAMES the tile references. */
export interface DashboardTileSpec {
  run: string;
  name: string;
  givens: string[];
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
  type EngineRuntime = Parameters<typeof dashboardGivenSpecs>[0];
  return withModelRuntime(files, found.model.id, async (runtime) => {
    const rt = runtime as unknown as EngineRuntime;
    const byName = new Map<string, DashboardGivenSpec>();
    const out: DashboardTileSpec[] = [];
    for (const tile of tiles) {
      const specs = await dashboardGivenSpecs(rt, entry, tile);
      const gvs = specs.ok ? specs.givens : [];
      for (const s of gvs) if (!byName.has(s.name)) byName.set(s.name, s);
      out.push({ run: tile, name: tileName(tile), givens: gvs.map((s) => s.name) });
    }
    return { ok: true, tiles: out, union: [...byName.values()] };
  });
}

/** Everything a host needs to render a dashboard: the stored artifact plus the
    `__DASHBOARD__` info object (mirrors the model's `# artifact` tag) and the
    given specs (the control contract). Shared by the sandboxed-iframe frame
    route (custom dashboards) and the in-page trusted renderer (tag-only, via the
    /view route) so the two paths can never drift. `info` is JSON-serializable. */
export interface DashboardViewData {
  dash: DashboardDetail;
  info: Record<string, unknown>;
  givenSpecs: unknown[];
}

export async function dashboardViewData(
  userId: string,
  datasetId: string,
  name: string,
): Promise<DashboardViewData | null> {
  const dash = await getDashboard(userId, datasetId, name);
  if (!dash) return null;
  // For a COMPOSITE dashboard, one pass yields both the union (controls) and
  // each tile's given NAMES; single-query dashboards use dashboardGivens.
  const composite = Array.isArray(dash.manifest.tiles) ? await dashboardTileSpecs(userId, datasetId, name) : null;
  let givenSpecs: unknown[] = [];
  let tileSpecs: unknown[] | undefined;
  if (composite) {
    if (composite.ok) {
      givenSpecs = composite.union;
      tileSpecs = composite.tiles;
    }
  } else {
    const specs = await dashboardGivens(userId, datasetId, name);
    if (specs.ok) givenSpecs = specs.givens;
  }
  const info = {
    name: dash.name,
    query: dash.manifest.query,
    tiles: dash.manifest.tiles,
    tileSpecs,
    dashboard_columns: dash.manifest.dashboard_columns,
    title: dash.title,
    description: dash.manifest.description,
    givens: dash.manifest.givens,
    autorun: dash.manifest.autorun,
  };
  return { dash, info, givenSpecs };
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
