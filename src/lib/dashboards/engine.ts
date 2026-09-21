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

import { eq } from "drizzle-orm";
import { dashboardGivenSpecs, runRestricted, type DashboardGivenSpec } from "@malloyyo/mcp-engine";
import { db, malloyModels } from "@/db";
import { findByDatasetRef, modelFileMap } from "@/lib/mcp-tools";
import { runNamedMalloyFiles, withModelRuntime, fileUrl } from "@/lib/malloy";
import { getDashboard, modelConfigJson, type DashboardDetail } from "./meta";
import { imageHostsFromConfig } from "./image-hosts";
import { rendersNoData } from "./about";

export type { DashboardDetail };

/**
 * The files a dashboard compiles against and the key its runtime is pooled
 * under. A published dashboard: its model's files, keyed by the model. A
 * draft: the model's files (the dataset's CURRENT version — meta.ts resolves
 * it) with its own dashboard file laid over them, keyed by the draft row's
 * version, so a save is a new runtime rather than a stale compile.
 */
async function dashboardFiles(dash: DashboardDetail): Promise<{ files: Map<string, string>; cacheKey: string }> {
  const [model] = await db.select().from(malloyModels).where(eq(malloyModels.id, dash.modelId)).limit(1);
  if (!model) throw new Error("dashboard model not found");
  const files = await modelFileMap(model);
  if (!dash.draft) return { files, cacheKey: model.id };
  for (const [path, content] of Object.entries(dash.draft.files)) files.set(path, content);
  return { files, cacheKey: `${model.id}:draft:${dash.draft.id}:${dash.draft.version}` };
}

/** Card name for a tile run-expression: the view name from `source -> view`,
    else the query name. */
function tileName(runExpr: string): string {
  const arrow = runExpr.lastIndexOf("->");
  return (arrow >= 0 ? runExpr.slice(arrow + 2) : runExpr).trim();
}

export type DashboardRunResult =
  | { ok: true; stableResult: unknown; rows?: unknown[]; rowCount: number }
  | { ok: false; error: string };

/**
 * A run string beginning with `run:` is Malloy TEXT; anything else names a
 * run-expression. Unambiguous, because a run-expression is `source -> view` or
 * a bare view name and cannot begin with `run:`.
 *
 * This lets one wire field carry either, which is what a panel needs — it has
 * a single `run` call, not two.
 */
export function isMalloyText(s: string): boolean {
  return /^\s*run\s*:/.test(s);
}

/**
 * A dashboard query's problems, as a sentence its author can act on.
 *
 * Malloy text here may be a bare run-expression, a `run:` statement, or a
 * document that defines sources and then runs one — the same three the MCP
 * `query` tool takes. A document with no `run:` compiles to a model with
 * nothing to execute, and core reports that as an internal compiler error,
 * which tells the author nothing. Name the missing piece instead.
 */
export function explainProblems(problems: Array<{ message: string }>): string {
  const text = problems.map((p) => p.message).join("; ");
  if (/Model has no queries/.test(text)) {
    return "that Malloy defines things but never runs one — finish it with `run: <source> -> { … }`";
  }
  return text || "query failed";
}

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
  const a = await getDashboard(userId, datasetId, name);
  if (!a) return { ok: false, error: `dashboard '${name}' not found` };
  const { files, cacheKey } = await dashboardFiles(a);

  const manifest = a.manifest;
  const entryFile = typeof manifest.entryFile === "string" ? manifest.entryFile : "index.malloy";

  // One field, two meanings: `query` carrying `run:` IS Malloy text. Callers
  // that still set `malloy` explicitly keep working.
  const malloyText =
    typeof req.malloy === "string"
      ? req.malloy
      : typeof req.query === "string" && isMalloyText(req.query)
        ? req.query
        : null;

  // Tiles AND ad-hoc text compile against the dashboard's own file, as the
  // CLI dev server does (packages/cli/src/dashboard.ts): a suggest query or a
  // <VegaChart malloy=…> may name a source that only the dashboard file
  // defines. Compiling ad-hoc text against index.malloy instead would pass in
  // `malloyyo dashboard dev` and fail once published. Reach is unchanged —
  // the restricted gate below is what bounds it, and the dashboard file
  // imports index.malloy anyway.
  const entry = fileUrl(entryFile);

  if (malloyText !== null) {
    // Restricted text: core rejects anything outside the model's published
    // surface with 'restricted-construct-forbidden'. The runtime cast bridges
    // the app/engine duplicate @malloydata/malloy installs (same seam as
    // mcp-host.ts) — one runtime object, two identical declaration trees.
    type EngineRuntime = Parameters<typeof runRestricted>[0];
    const out = await withModelRuntime(files, cacheKey, (runtime) =>
      runRestricted(runtime as unknown as EngineRuntime, entry, malloyText, {
        givens: givens ?? {},
        stableResult: true,
        rowLimit: maxRows,
      }),
    );
    if (!out.ok) return { ok: false, error: explainProblems(out.problems ?? []) };
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
      cacheKey,
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
  const tiles = Array.isArray(dash.manifest.tiles) ? (dash.manifest.tiles as string[]) : null;
  if (!tiles) return { ok: false, error: "dashboard is not composite" };
  const { files, cacheKey } = await dashboardFiles(dash);
  const entryFile = typeof dash.manifest.entryFile === "string" ? dash.manifest.entryFile : "index.malloy";
  const entry = fileUrl(entryFile);
  type EngineRuntime = Parameters<typeof dashboardGivenSpecs>[0];
  return withModelRuntime(files, cacheKey, async (runtime) => {
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
  /** Validated `img-src` hosts from the repo's malloy-config.json. Only the
      sandboxed frame route uses these (it sends the CSP); the in-page tag-only
      renderer runs in the trusted document and has no such restriction. */
  imageHosts: string[];
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
  // A page that runs no data (the About page) has no query to introspect and no
  // entry file to compile. Skipping is not just an optimisation: dashboardGivens
  // would fall back to index.malloy, compile the model, fail to find a query
  // that does not exist, and the failure would be swallowed — paying a full
  // model compile per load to learn nothing.
  const noData = rendersNoData(dash.manifest);
  const composite =
    !noData && Array.isArray(dash.manifest.tiles) ? await dashboardTileSpecs(userId, datasetId, name) : null;
  let givenSpecs: unknown[] = [];
  let tileSpecs: unknown[] | undefined;
  if (noData) {
    // nothing to resolve
  } else if (composite) {
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
  return { dash, info, givenSpecs, imageHosts: imageHostsFromConfig(await modelConfigJson(dash.modelId)) };
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
  const { files, cacheKey } = await dashboardFiles(dash);
  const entryFile = typeof dash.manifest.entryFile === "string" ? dash.manifest.entryFile : "index.malloy";
  const entry = fileUrl(entryFile);
  const tiles = Array.isArray(dash.manifest.tiles) ? (dash.manifest.tiles as string[]) : null;
  type EngineRuntime = Parameters<typeof dashboardGivenSpecs>[0];

  // Composite: the controls are the UNION of givens across the tiles, resolved
  // in the dashboard file's own scope (a given is declared once at model scope).
  if (tiles) {
    return withModelRuntime(files, cacheKey, async (runtime) => {
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
  return withModelRuntime(files, cacheKey, (runtime) =>
    dashboardGivenSpecs(runtime as unknown as EngineRuntime, entry, query),
  );
}
