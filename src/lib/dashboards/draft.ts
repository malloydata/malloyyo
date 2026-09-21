// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Saving a draft dashboard — the Malloy half, so API routes only (it reaches
// @/lib/malloy and DuckDB; see the note at the top of ./engine). Reading one
// back is ./meta's getDashboard, which every dashboard route already calls.
//
// A draft dashboard is exactly what a model repo would hold for one
// dashboard: `dashboards/<name>.malloy` (importing ../index.malloy) and an
// optional component. Keeping that shape is what lets it move into the repo
// unchanged later.
//
// GOVERNANCE. A published dashboard file is trusted because its author
// committed it. A draft's file comes from any member with the `mcp` scope, and
// compiling Malloy can already run SQL (schema lookups on `duckdb.sql(...)`,
// `connection.table(...)`). So before the file is compiled as a model file at
// all, its body — the file minus its `import "../index.malloy"` line — must
// pass core's restricted gate against index.malloy: no raw SQL, no connection
// access, no other imports, no `given:` declarations. That is the same contract
// the explore `query` tool runs under, so a draft dashboard can reach exactly
// what a query can. The stored text is the validated text; every save
// re-validates.

import { and, desc, eq } from "drizzle-orm";
import { modelArtifact, validateRestricted, type Problem } from "@malloyyo/mcp-engine";
import { db, draftDashboards } from "@/db";
import { findByDatasetRef, modelFileMap } from "@/lib/mcp-tools";
import { fileUrl, runNamedMalloyFiles, withModelRuntime } from "@/lib/malloy";
import { newDatasetSlug } from "@/lib/slug";
import { bundleDashboard } from "./bundle";
import { artifactManifest } from "./manifest";
import { DRAFT_PREFIX } from "./meta";

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const MAX_TEXT = 256 * 1024;
/** Rows fetched per tile when a save test-runs its queries — a check, not a read. */
const TILE_SAMPLE_ROWS = 3;

/** The one import a draft dashboard file may carry: the model's own entry. */
const INDEX_IMPORT_RE = /^[ \t]*import[ \t]+(["'])\.\.\/index\.malloy\1[ \t]*;?[ \t]*$/gm;

/**
 * The compiler flags a draft dashboard file may set. Restricted mode forbids
 * `##!` outright, but a dashboard using givens can't compile without
 * `##! experimental { givens }` in its own file — every real dashboard file
 * starts with it. These two switch on language features (given references,
 * access modifiers); neither widens what the file can reach, which is what the
 * gate is about. Any other `##!` content stays in the body and is rejected.
 */
const ALLOWED_EXPERIMENTS = new Set(["givens", "access_modifiers"]);
const EXPERIMENT_RE = /^[ \t]*##![ \t]*experimental[ \t]*\{([^}\n]*)\}[ \t]*$/gm;

export interface DraftInput {
  /** The dashboard's name — its file basename, e.g. "trend". */
  name: string;
  /** dashboards/<name>.malloy. Optional: a component that runs its own
      queries inline (useQuery({malloy})) needs no dashboard file at all. */
  malloy?: string;
  /** Title for a component-only draft; a .malloy file carries its own. */
  title?: string;
  /** One line saying what the dashboard answers — shown under its title in
      listings. A .malloy file carries its own, as the tag's `#"` doc line. */
  description?: string;
  /** The optional component (JSX/TSX). Empty or absent: a tag-only dashboard. */
  source?: string;
  /** Overwrite this draft dashboard (it must be the caller's) instead of making a new one. */
  slug?: string;
}

export interface DraftTileReport {
  run: string;
  ok: boolean;
  rowCount?: number;
  columns?: string[];
  sample?: unknown[];
  error?: string;
}

export type DraftSaveResult =
  | {
      ok: true;
      slug: string;
      /** The dashboard name every route takes: `draft-<slug>`. */
      dashboard: string;
      dataset: string;
      title: string;
      url: string;
      tiles: DraftTileReport[];
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
export function draftBody(malloy: string): string {
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

export async function saveDraftDashboard(
  userId: string,
  datasetRef: string,
  input: DraftInput,
  origin: string,
): Promise<DraftSaveResult> {
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
  let existing: typeof draftDashboards.$inferSelect | undefined;
  if (input.slug) {
    [existing] = await db
      .select()
      .from(draftDashboards)
      .where(and(eq(draftDashboards.slug, input.slug), eq(draftDashboards.datasetId, found.ds.id)))
      .limit(1);
    if (!existing) return { ok: false, error: `no draft dashboard '${input.slug}' in '${found.ds.name}'` };
    if (existing.userId !== userId) return { ok: false, error: "that draft dashboard belongs to someone else" };
  }

  const baseFiles = await modelFileMap(found.model);
  const files = new Map(baseFiles);
  const entryFile = `dashboards/${name}.malloy`;
  type EngineRuntime = Parameters<typeof validateRestricted>[0];

  // A component-only draft has no dashboard file to gate or read a tag from:
  // its queries are inline restricted Malloy, checked when they run, against
  // the model's published surface. The manifest is then just a title — the
  // same queryless shape the written About page uses.
  //
  // What the caller leaves out on an update it KEEPS: iterating on a draft
  // means re-sending the component, not restating its title every time.
  const previous = (existing?.manifest ?? {}) as { description?: unknown };
  const description =
    input.description !== undefined
      ? String(input.description).trim()
      : typeof previous.description === "string"
        ? previous.description
        : "";
  let title = String(input.title ?? existing?.title ?? name);
  let manifest: Record<string, unknown> = {
    title,
    ...(description ? { description } : {}),
  };

  if (malloy.trim()) {
    // 1. The gate — against the model's own files, before this file is compiled.
    const gate = await withModelRuntime(baseFiles, found.model.id, (runtime) =>
      validateRestricted(runtime as unknown as EngineRuntime, fileUrl("index.malloy"), draftBody(malloy)),
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
    ? await db.update(draftDashboards).set(values).where(eq(draftDashboards.id, existing.id)).returning()
    : await db
        .insert(draftDashboards)
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
  const cacheKey = `${found.model.id}:draft:${row.id}:${row.updatedAt.toISOString()}`;
  const tiles: DraftTileReport[] = [];
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

  // 6. The component's own inline queries, compiled (not run) — the only check
  //    a component-only draft can get before a viewer opens it.
  //
  //    Against the file they will actually compile against at runtime: a
  //    draft's own dashboards/<name>.malloy when it has one (runDashboard uses
  //    entryFile), index.malloy when it doesn't. Checking a two-file draft's
  //    inline queries against index.malloy would report a working query that
  //    names a source the draft file defines as undefined.
  const inline = inlineQueries(source);
  if (inline.length > 0) {
    const hasMalloy = malloy.trim().length > 0;
    const inlineEntry = fileUrl(hasMalloy ? entryFile : "index.malloy");
    await withModelRuntime(hasMalloy ? files : baseFiles, hasMalloy ? cacheKey : found.model.id, async (runtime) => {
      for (const text of inline) {
        const v = await validateRestricted(runtime as unknown as EngineRuntime, inlineEntry, text);
        const label = text.replace(/\s+/g, " ").slice(0, 60);
        tiles.push(
          v.ok
            ? { run: label, ok: true }
            : { run: label, ok: false, error: v.problems.map((p) => p.message).join("; ") },
        );
      }
    });
  }

  const dashboard = `${DRAFT_PREFIX}${row.slug}`;
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

// ── promotion ────────────────────────────────────────────────────────────────

export interface DraftSummary {
  slug: string;
  dashboard: string;
  name: string;
  title: string;
  updatedAt: string;
  hasComponent: boolean;
  hasMalloy: boolean;
  promotedAs: string | null;
}

/** This user's drafts on a dataset, newest first — what `malloyyo draft list`
    shows so a promoter can pick one without hunting for a slug. */
export async function listDrafts(userId: string, datasetRef: string): Promise<DraftSummary[]> {
  const found = await findByDatasetRef(userId, datasetRef);
  if (!found) return [];
  const rows = await db
    .select()
    .from(draftDashboards)
    .where(and(eq(draftDashboards.datasetId, found.ds.id), eq(draftDashboards.userId, userId)))
    .orderBy(desc(draftDashboards.updatedAt));
  return rows.map((r) => ({
    slug: r.slug,
    dashboard: `${DRAFT_PREFIX}${r.slug}`,
    name: r.name,
    title: r.title ?? r.name,
    updatedAt: r.updatedAt.toISOString(),
    hasComponent: r.source.trim().length > 0,
    hasMalloy: r.malloy.trim().length > 0,
    promotedAs: r.promotedAs,
  }));
}

export interface DraftFiles extends DraftSummary {
  malloy: string;
  source: string;
  /** The literal Malloy the component runs inline — what promotion must lift
      into named queries, since a repo dashboard's queries live in its
      .malloy file. */
  inline: string[];
}

/** One draft's files. Readable by anyone who can see the dataset: they can
    already open the dashboard and read its compiled bundle. */
export async function getDraftFiles(userId: string, datasetRef: string, slug: string): Promise<DraftFiles | null> {
  const found = await findByDatasetRef(userId, datasetRef);
  if (!found) return null;
  const [r] = await db
    .select()
    .from(draftDashboards)
    .where(and(eq(draftDashboards.slug, slug), eq(draftDashboards.datasetId, found.ds.id)))
    .limit(1);
  if (!r) return null;
  return {
    slug: r.slug,
    dashboard: `${DRAFT_PREFIX}${r.slug}`,
    name: r.name,
    title: r.title ?? r.name,
    updatedAt: r.updatedAt.toISOString(),
    hasComponent: r.source.trim().length > 0,
    hasMalloy: r.malloy.trim().length > 0,
    promotedAs: r.promotedAs,
    malloy: r.malloy,
    source: r.source,
    inline: inlineQueries(r.source),
  };
}

/**
 * Record that a draft was written into a repo as `name`, with a hash of what
 * was written.
 *
 * NOT a delete and NOT a lock. The draft stays the only usable copy until the
 * model version carrying the promoted dashboard goes live, people hold its
 * URL, and nothing bad happens if it keeps being edited afterwards — the hash
 * is what shows the two have diverged.
 *
 * The draft's OWNER writes this, as with saving one: the record is what a
 * later forward and any divergence check read, so it should say what the
 * author did, not what a passer-by did with a copy. Anyone who can see the
 * dataset may still read the files and write them into a checkout.
 */
export async function recordPromotion(
  userId: string,
  datasetRef: string,
  slug: string,
  promoted: { name: string; hash: string },
): Promise<"recorded" | "not-found" | "not-yours"> {
  const found = await findByDatasetRef(userId, datasetRef);
  if (!found) return "not-found";
  const [row] = await db
    .select()
    .from(draftDashboards)
    .where(and(eq(draftDashboards.slug, slug), eq(draftDashboards.datasetId, found.ds.id)))
    .limit(1);
  if (!row) return "not-found";
  if (row.userId !== userId) return "not-yours";
  await db
    .update(draftDashboards)
    .set({ promotedAs: promoted.name, promotedHash: promoted.hash, promotedAt: new Date() })
    .where(eq(draftDashboards.id, row.id));
  return "recorded";
}
