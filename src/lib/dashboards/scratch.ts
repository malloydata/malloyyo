// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Saving a scratch dashboard — the Malloy half, so API routes only (it reaches
// @/lib/malloy and DuckDB; see the note at the top of ./engine). Reading one
// back is ./meta's getDashboard, which every dashboard route already calls.
//
// A scratch dashboard is exactly what a model repo would hold for one
// dashboard: `dashboards/<name>.malloy` (importing ../index.malloy) and an
// optional component. Keeping that shape is what lets it move into the repo
// unchanged later.
//
// GOVERNANCE. A published dashboard file is trusted because its author
// committed it. A scratch file comes from any member with the `mcp` scope, and
// compiling Malloy can already run SQL (schema lookups on `duckdb.sql(...)`,
// `connection.table(...)`). So before the file is compiled as a model file at
// all, its body — the file minus its `import "../index.malloy"` line — must
// pass core's restricted gate against index.malloy: no raw SQL, no connection
// access, no other imports, no `given:` declarations. That is the same contract
// the explore `query` tool runs under, so a scratch dashboard can reach exactly
// what a query can. The stored text is the validated text; every save
// re-validates.

import { and, eq } from "drizzle-orm";
import { modelArtifact, validateRestricted, type Problem } from "@malloyyo/mcp-engine";
import { db, scratchDashboards } from "@/db";
import { findByDatasetRef, modelFileMap } from "@/lib/mcp-tools";
import { fileUrl, runNamedMalloyFiles, withModelRuntime } from "@/lib/malloy";
import { newDatasetSlug } from "@/lib/slug";
import { bundleDashboard } from "./bundle";
import { artifactManifest } from "./manifest";
import { SCRATCH_PREFIX } from "./meta";

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const MAX_TEXT = 256 * 1024;
/** Rows fetched per tile when a save test-runs its queries — a check, not a read. */
const TILE_SAMPLE_ROWS = 3;

/** The one import a scratch dashboard file may carry: the model's own entry. */
const INDEX_IMPORT_RE = /^[ \t]*import[ \t]+(["'])\.\.\/index\.malloy\1[ \t]*;?[ \t]*$/gm;

/**
 * The compiler flags a scratch dashboard file may set. Restricted mode forbids
 * `##!` outright, but a dashboard using givens can't compile without
 * `##! experimental { givens }` in its own file — every real dashboard file
 * starts with it. These two switch on language features (given references,
 * access modifiers); neither widens what the file can reach, which is what the
 * gate is about. Any other `##!` content stays in the body and is rejected.
 */
const ALLOWED_EXPERIMENTS = new Set(["givens", "access_modifiers"]);
const EXPERIMENT_RE = /^[ \t]*##![ \t]*experimental[ \t]*\{([^}\n]*)\}[ \t]*$/gm;

export interface ScratchInput {
  /** The dashboard's name — its file basename, e.g. "trend". */
  name: string;
  /** dashboards/<name>.malloy. Optional: a component that runs its own
      queries inline (useQuery({malloy})) needs no dashboard file at all. */
  malloy?: string;
  /** Title for a component-only draft; a .malloy file carries its own. */
  title?: string;
  /** The optional component (JSX/TSX). Empty or absent: a tag-only dashboard. */
  source?: string;
  /** Overwrite this scratch dashboard (it must be the caller's) instead of making a new one. */
  slug?: string;
}

export interface ScratchTileReport {
  run: string;
  ok: boolean;
  rowCount?: number;
  columns?: string[];
  sample?: unknown[];
  error?: string;
}

export type ScratchSaveResult =
  | {
      ok: true;
      slug: string;
      /** The dashboard name every route takes: `scratch-<slug>`. */
      dashboard: string;
      dataset: string;
      title: string;
      url: string;
      tiles: ScratchTileReport[];
      component: { ok: boolean; error?: string; line?: number };
    }
  | { ok: false; error: string; problems?: Problem[] };

/**
 * The Malloy a component runs inline: `useQuery({ malloy: `run: …` })`,
 * `<VegaChart malloy={`run: …`}>`, `runData(`run: …`)`. Checked at save so a
 * component-only draft gets the same "this query is wrong, and why" report a
 * dashboard file gets — otherwise its queries fail for the first viewer.
 *
 * Literals only: a query built from a template expression is skipped (it can
 * only be judged when it runs), as is anything not starting with `run:`.
 */
export function inlineQueries(source: string): string[] {
  const out = new Set<string>();
  const patterns = [/\b(?:malloy|query)\s*:\s*`([^`]*)`/g, /\brunData\s*\(\s*`([^`]*)`/g];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) {
      const text = m[1];
      if (text.includes("${") || !/^\s*run\s*:/.test(text)) continue;
      out.add(text.trim());
    }
  }
  return [...out];
}

/** The file minus its `import "../index.malloy"` and its allowed
    `##! experimental { … }` line — what the gate checks. */
export function scratchBody(malloy: string): string {
  return malloy
    .replace(INDEX_IMPORT_RE, "")
    .replace(EXPERIMENT_RE, (line, flags: string) => {
      const names = flags.split(/[\s,]+/).filter(Boolean);
      return names.length > 0 && names.every((n) => ALLOWED_EXPERIMENTS.has(n)) ? "" : line;
    });
}

/** The only problem restricted mode raises for clean definitions-only text:
    it expects a `run:`, and a dashboard file has none. Anything else is real. */
function isNoQueriesProblem(p: Problem): boolean {
  return /Model has no queries/.test(p.message);
}

export async function saveScratchDashboard(
  userId: string,
  datasetRef: string,
  input: ScratchInput,
  origin: string,
): Promise<ScratchSaveResult> {
  const name = String(input.name ?? "").trim();
  if (!NAME_RE.test(name)) {
    return { ok: false, error: "name must be letters, digits, '-' or '_' (the dashboard file's basename)" };
  }
  const malloy = String(input.malloy ?? "");
  const source = String(input.source ?? "");
  if (!malloy.trim() && !source.trim()) {
    return { ok: false, error: "give a component (source), a dashboards/<name>.malloy, or both" };
  }
  if (malloy.length > MAX_TEXT || source.length > MAX_TEXT) {
    return { ok: false, error: `each file is limited to ${MAX_TEXT / 1024} KB` };
  }

  const found = await findByDatasetRef(userId, datasetRef);
  if (!found) return { ok: false, error: `dataset '${datasetRef}' not found` };
  if (found.ds.status !== "ready") return { ok: false, error: "dataset not ready" };

  // Overwrite only your own. Checked before any compile work.
  let existing: typeof scratchDashboards.$inferSelect | undefined;
  if (input.slug) {
    [existing] = await db
      .select()
      .from(scratchDashboards)
      .where(and(eq(scratchDashboards.slug, input.slug), eq(scratchDashboards.datasetId, found.ds.id)))
      .limit(1);
    if (!existing) return { ok: false, error: `no scratch dashboard '${input.slug}' in '${found.ds.name}'` };
    if (existing.userId !== userId) return { ok: false, error: "that scratch dashboard belongs to someone else" };
  }

  const baseFiles = await modelFileMap(found.model);
  const files = new Map(baseFiles);
  const entryFile = `dashboards/${name}.malloy`;
  type EngineRuntime = Parameters<typeof validateRestricted>[0];

  // A component-only draft has no dashboard file to gate or read a tag from:
  // its queries are inline restricted Malloy, checked when they run, against
  // the model's published surface. The manifest is then just a title — the
  // same queryless shape the written About page uses.
  let manifest: Record<string, unknown> = { title: String(input.title ?? name) };
  let title = String(input.title ?? name);

  if (malloy.trim()) {
    // 1. The gate — against the model's own files, before this file is compiled.
    const gate = await withModelRuntime(baseFiles, found.model.id, (runtime) =>
      validateRestricted(runtime as unknown as EngineRuntime, fileUrl("index.malloy"), scratchBody(malloy)),
    );
    const blocking = gate.ok ? [] : gate.problems.filter((p) => p.severity === "error" && !isNoQueriesProblem(p));
    if (blocking.length > 0) {
      return {
        ok: false,
        error: `dashboards/${name}.malloy failed the restricted check (it may only build on what index.malloy publishes)`,
        problems: blocking,
      };
    }

    // 2. Now safe to compile as the dashboard's own entry: read its `# artifact`.
    files.set(entryFile, malloy);
    const art = await withModelRuntime(files, undefined, (runtime) =>
      modelArtifact(runtime as unknown as Parameters<typeof modelArtifact>[0], fileUrl(entryFile), name),
    );
    if (!art.ok) return { ok: false, error: `dashboards/${name}.malloy does not compile: ${art.error}` };
    if (!art.artifact) {
      return {
        ok: false,
        error:
          `dashboards/${name}.malloy declares no dashboard: tag a query \`# artifact\`, ` +
          "or the file `## artifact { tiles=[…] }` (yo_help dashboards/authoring)",
      };
    }
    manifest = artifactManifest(name, art.artifact);
    title = String(art.artifact.title ?? name);
  }

  // 3. The component compiles (esbuild-wasm). A failure is reported, not fatal:
  //    the dashboard still saves, so its data side can be checked meanwhile.
  let component: { ok: boolean; error?: string; line?: number } = { ok: true };
  if (source.trim()) {
    try {
      await bundleDashboard(source);
    } catch (e) {
      const first = (e as { errors?: Array<{ text: string; location?: { line: number } }> }).errors?.[0];
      component = { ok: false, error: first?.text ?? String(e), line: first?.location?.line };
    }
  }

  // 4. Store — re-pinned to the dataset's current model.
  const values = {
    modelId: found.model.id,
    name,
    title,
    manifest,
    malloy,
    source,
    updatedAt: new Date(),
  };
  const [row] = existing
    ? await db.update(scratchDashboards).set(values).where(eq(scratchDashboards.id, existing.id)).returning()
    : await db
        .insert(scratchDashboards)
        .values({ ...values, slug: newDatasetSlug(), userId, datasetId: found.ds.id })
        .returning();

  // 5. Test-run every tile under the key the dashboard will render with, so the
  //    first view reuses this compile. Givens without defaults fail here, and
  //    that is reported as-is — it is what the dashboard would show.
  const runs = Array.isArray(manifest.tiles)
    ? (manifest.tiles as string[])
    : typeof manifest.query === "string"
      ? [manifest.query]
      : [];
  const cacheKey = `${found.model.id}:scratch:${row.id}:${row.updatedAt.toISOString()}`;
  const tiles: ScratchTileReport[] = [];
  for (const run of runs) {
    try {
      const r = await runNamedMalloyFiles(files, entryFile, run, {}, { rowLimit: TILE_SAMPLE_ROWS, cacheKey });
      const sample = (r.rows ?? []).slice(0, TILE_SAMPLE_ROWS);
      const first = sample[0];
      tiles.push({
        run,
        ok: true,
        rowCount: r.rowCount,
        columns: first && typeof first === "object" ? Object.keys(first as object) : undefined,
        sample,
      });
    } catch (e) {
      tiles.push({ run, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // 6. The component's own inline queries, compiled (not run) against the
  //    model — the only check a component-only draft can get before a viewer
  //    opens it.
  const inline = inlineQueries(source);
  if (inline.length > 0) {
    await withModelRuntime(baseFiles, found.model.id, async (runtime) => {
      for (const text of inline) {
        const v = await validateRestricted(runtime as unknown as EngineRuntime, fileUrl("index.malloy"), text);
        const label = text.replace(/\s+/g, " ").slice(0, 60);
        tiles.push(
          v.ok
            ? { run: label, ok: true }
            : { run: label, ok: false, error: v.problems.map((p) => p.message).join("; ") },
        );
      }
    });
  }

  const dashboard = `${SCRATCH_PREFIX}${row.slug}`;
  return {
    ok: true,
    slug: row.slug,
    dashboard,
    dataset: found.ds.name,
    title,
    url: `${origin.replace(/\/$/, "")}/datasets/${encodeURIComponent(found.ds.name)}/dashboard/${dashboard}`,
    tiles,
    component,
  };
}

