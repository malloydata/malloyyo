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

import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { modelArtifact, validateRestricted, type Problem } from "@malloyyo/mcp-engine";
import { dashboardGrants, datasets, db, draftDashboards, DRAFT_VISIBILITIES, type DraftVisibility } from "@/db";
import { hasRole, MALLOYYO_ADMIN, type RoleBearing } from "@/lib/roles";
import { findByDatasetRef, modelFileMap } from "@/lib/mcp-tools";
import { fileUrl, runNamedMalloyFiles, withModelRuntime } from "@/lib/malloy";
import { newDatasetSlug } from "@/lib/slug";
import { bundleDashboard } from "./bundle";
import { declaredRuns, explainProblems } from "./engine";
import { artifactManifest } from "./manifest";
import { mayOpenDashboard } from "./audience";
import { DRAFT_PREFIX } from "./meta";
import { applyDraftEdits, draftBody, draftFile, type DraftEdit } from "./draft-text";

export { draftBody, MAX_DRAFT_EDITS, type DraftEdit } from "./draft-text";

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const MAX_TEXT = 256 * 1024;
/** Rows fetched per tile when a save test-runs its queries — a check, not a read. */
const TILE_SAMPLE_ROWS = 3;

export interface DraftInput {
  /** The dashboard's name — its file basename, e.g. "trend". With `edits` it
      may be left out (the draft keeps its name), and must match if given. */
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
  /** With `slug`: instead of resending a whole file, exact-match find/replace
      edits applied to the stored draft. Each `find` must occur exactly once in
      its file (`source` by default, or `malloy`). */
  edits?: DraftEdit[];
  /** Who else may open it: `private` (its author, admins, and the people it is
      shared with) or `dataset` (everyone who can open the dataset). A new draft
      is private; an update that leaves this out keeps what the draft has. */
  visibility?: DraftVisibility;
}

export function isDraftVisibility(v: unknown): v is DraftVisibility {
  return (DRAFT_VISIBILITIES as readonly unknown[]).includes(v);
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
      /** Who else can open that URL — see DraftInput.visibility. */
      visibility: DraftVisibility;
      tiles: DraftTileReport[];
      component: { ok: boolean; error?: string; line?: number };
    }
  | { ok: false; error: string; problems?: Problem[] };

/**
 * The Malloy a component runs, wherever it wrote it.
 *
 * EVERY template literal in the component that carries a `run:` statement —
 * not just the ones written inside `useQuery({ malloy: … })`. Real components
 * hold their query in a `const` and pass the variable, and a check that only
 * looked inside the call reported "0/0 ran" on a dashboard whose query was
 * wrong, leaving the mistake for the first person to open the page.
 *
 * A literal carrying `${…}` is skipped: it is assembled at runtime and can
 * only be judged then. So is one with no `run:` — a bare run-expression
 * (`flights -> by_carrier`) is indistinguishable from ordinary prose, and the
 * runtime's asRunText is what turns it into a query.
 */
export function inlineQueries(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/`([^`]*)`/g)) {
    const text = m[1];
    if (text.includes("${")) continue;
    if (!/(^|\n)\s*run\s*:/.test(text)) continue;
    out.add(text.trim());
  }
  return [...out];
}

/** The only problem restricted mode raises for clean definitions-only text:
    it expects a `run:`, and a dashboard file has none. Anything else is real. */
function isNoQueriesProblem(p: Problem): boolean {
  return /Model has no queries/.test(p.message);
}

/**
 * Overwrite a stored draft with `values`, returning the new row, or undefined
 * when nothing was written. With `ifUnchanged`, the write lands only if the
 * row is still the version `read` was: every save stamps `updatedAt`, so it is
 * the draft's version. Compared at millisecond precision, which is all a JS
 * Date holds of the microseconds Postgres stores.
 */
export async function updateDraftRow(
  read: { id: string; updatedAt: Date },
  values: Partial<typeof draftDashboards.$inferInsert> & { updatedAt: Date },
  { ifUnchanged }: { ifUnchanged: boolean },
): Promise<typeof draftDashboards.$inferSelect | undefined> {
  const byId = eq(draftDashboards.id, read.id);
  const where = ifUnchanged
    ? and(
        byId,
        sql`date_trunc('milliseconds', ${draftDashboards.updatedAt}) = ${read.updatedAt.toISOString()}::timestamptz`,
      )
    : byId;
  const [row] = await db.update(draftDashboards).set(values).where(where).returning();
  return row;
}

/** Why a draft's files can't be saved as they are, or null. */
function fileProblem(malloy: string, source: string): string | null {
  if (!malloy.trim() && !source.trim()) return "give a component (source), a dashboards/<name>.malloy, or both";
  if (malloy.length > MAX_TEXT || source.length > MAX_TEXT) return `each file is limited to ${MAX_TEXT / 1024} KB`;
  return null;
}

export async function saveDraftDashboard(
  userId: string,
  datasetRef: string,
  input: DraftInput,
  origin: string,
): Promise<DraftSaveResult> {
  const editing = !!input.edits?.length;
  // An empty file sent alongside edits is a client filling an optional field,
  // not a second instruction — only real text conflicts with them.
  const hasText = (s: unknown) => typeof s === "string" && s.trim() !== "";
  let name = String(input.name ?? "").trim();
  if ((name || !editing) && !NAME_RE.test(name)) {
    return { ok: false, error: "name must be letters, digits, '-' or '_' (the dashboard file's basename)" };
  }
  if (editing && !input.slug) {
    return { ok: false, error: "edits need the slug of the draft to change" };
  }
  if (editing && (hasText(input.source) || hasText(input.malloy))) {
    return { ok: false, error: "send edits or whole files, not both" };
  }
  if (input.visibility !== undefined && !isDraftVisibility(input.visibility)) {
    return { ok: false, error: `visibility must be one of: ${DRAFT_VISIBILITIES.join(", ")}` };
  }

  // Whole files are checked here, before any database work; edited ones once
  // the stored draft they apply to has been read.
  let malloy = draftFile(String(input.malloy ?? ""));
  let source = String(input.source ?? "");
  if (!editing) {
    const bad = fileProblem(malloy, source);
    if (bad) return { ok: false, error: bad };
  }

  // A draft is built out of queries its author wrote, so saving one takes the
  // right to QUERY the dataset. Someone who can only view it gets the same
  // answer as someone who cannot see it at all.
  const found = await findByDatasetRef(userId, datasetRef, "query");
  if (!found) return { ok: false, error: `dataset '${datasetRef}' not found` };
  // A draft belongs to a published dataset and is listed to its readers; one
  // validated against an unpublished preview's model would land there anyway.
  if ("preview" in found) {
    return {
      ok: false,
      error: "Drafts are saved on a published dataset, not a branch preview. In a clone, add the dashboard to the repo and preview_changes instead.",
    };
  }

  // The canonical ref, for the `dataset` and `url` this returns: the caller's
  // own `datasetRef` may be any spelling — a uuid, an alias, a bare name — so
  // it is not the address to hand back.
  const qualified = found.ref;
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

  if (editing) {
    // `slug` is required with edits, and a missing draft returned above.
    const base = existing!;
    // An edit changes the text, not which file it is: a different name here
    // would quietly rename the dashboard (its file, its artifact, what a
    // promote writes), so it is refused rather than taken.
    if (name && name !== base.name) {
      return {
        ok: false,
        error: `this draft is named '${base.name}'; edits keep its name (leave name out, or send whole files to rename it)`,
      };
    }
    name = base.name;
    const r = applyDraftEdits({ source: base.source, malloy: base.malloy }, input.edits!, MAX_TEXT);
    if (!r.ok) return { ok: false, error: r.error };
    source = r.source;
    malloy = draftFile(r.malloy);
    const bad = fileProblem(malloy, source);
    if (bad) return { ok: false, error: bad };
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

    // 2b. Every run-expression the tag declares, under the same gate as the
    //     body — because the gate above cannot see them.
    //
    //     `## artifact { tiles=[…] }` is an ANNOTATION, which is a comment to
    //     the compiler. So step 1 validating the draft's body says nothing
    //     about the strings inside that tag, and those strings are what step 5
    //     runs and what every later view compiles. A draft is writable by any
    //     member who can see the dataset, so they are request text with a
    //     manifest's reach unless they are checked here.
    //
    //     Validated against the draft's own entry rather than index.malloy: a
    //     tile may legitimately name a source the draft file defines. That
    //     composes safely, because the body it builds on passed step 1 and so
    //     only builds on what the model publishes.
    const declared = declaredRuns(manifest);
    for (const run of declared) {
      const tileGate = await withModelRuntime(files, undefined, (runtime) =>
        validateRestricted(runtime as unknown as EngineRuntime, fileUrl(entryFile), `run: ${run}`),
      );
      const bad = tileGate.ok
        ? []
        : tileGate.problems.filter((p) => p.severity === "error" && !isNoQueriesProblem(p));
      if (bad.length > 0) {
        return {
          ok: false,
          error:
            `a dashboard query in dashboards/${name}.malloy failed the restricted check ` +
            "(it may only build on what the model publishes)",
          problems: bad,
        };
      }
    }
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
    // Only when asked. Left out, an update keeps the draft's audience and a new
    // row takes the column default, which is private.
    ...(input.visibility ? { visibility: input.visibility } : {}),
    updatedAt: new Date(),
  };
  // Edits were applied to the draft read above, and the checks since then take
  // a while, so an edit save writes only if no other save landed in between —
  // else it would put back that save's text, title and description with a
  // result computed from what it replaced. (A whole-file save states the
  // entire draft, so it stays last-writer-wins.)
  const row = existing
    ? await updateDraftRow(existing, values, { ifUnchanged: editing })
    : (
        await db
          .insert(draftDashboards)
          .values({ ...values, slug: newDatasetSlug(), userId, datasetId: found.ds.id })
          .returning()
      )[0];
  if (!row) {
    return {
      ok: false,
      error: editing
        ? "the draft changed or was deleted while these edits were being checked; nothing was saved. Re-read the draft and send the edits again."
        : "the draft was deleted while this save was being checked; nothing was saved",
    };
  }

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
            : { run: label, ok: false, error: explainProblems(v.problems) },
        );
      }
    });
  }

  const dashboard = `${DRAFT_PREFIX}${row.slug}`;
  return {
    ok: true,
    slug: row.slug,
    dashboard,
    dataset: qualified,
    title,
    // Qualified: this URL is handed straight to a caller to open, and the bare
    // name sent `save_draft_dashboard(dataset: "globex:orders")` a link to
    // acme's dataset.
    url: `${origin.replace(/\/$/, "")}/datasets/${encodeURIComponent(qualified)}/dashboard/${dashboard}`,
    visibility: row.visibility,
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
  const found = await findByDatasetRef(userId, datasetRef, "view");
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

/** One draft's files. Readable by anyone who can OPEN the draft: they can
    already read its compiled bundle. A private draft answers null to everyone
    else, the same as a slug that does not exist. */
export async function getDraftFiles(userId: string, datasetRef: string, slug: string): Promise<DraftFiles | null> {
  const found = await findByDatasetRef(userId, datasetRef, "view");
  if (!found) return null;
  const [r] = await db
    .select()
    .from(draftDashboards)
    .where(and(eq(draftDashboards.slug, slug), eq(draftDashboards.datasetId, found.ds.id)))
    .limit(1);
  if (!r) return null;
  const audience = { name: `${DRAFT_PREFIX}${r.slug}`, isPrivate: r.visibility === "private", authorId: r.userId };
  if (!(await mayOpenDashboard(userId, found.ds.id, audience))) return null;
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
  /** `hash` is of what was written; the CLI knows it. Without one (a chat that
      wrote the files into its clone) the draft's own content is hashed —
      "promoted from this version" — which is what a divergence check compares. */
  promoted: { name: string; hash?: string },
): Promise<"recorded" | "not-found" | "not-yours"> {
  const found = await findByDatasetRef(userId, datasetRef, "view");
  if (!found) return "not-found";
  const [row] = await db
    .select()
    .from(draftDashboards)
    .where(and(eq(draftDashboards.slug, slug), eq(draftDashboards.datasetId, found.ds.id)))
    .limit(1);
  if (!row) return "not-found";
  if (row.userId !== userId) return "not-yours";
  const draftName = `${DRAFT_PREFIX}${row.slug}`;
  await db.transaction(async (tx) => {
    await tx
      .update(draftDashboards)
      .set({
        promotedAs: promoted.name,
        promotedHash: promoted.hash ?? draftHash(row),
        promotedAt: new Date(),
      })
      .where(eq(draftDashboards.id, row.id));

    // PROMOTION DOES NOT CHANGE WHO CAN SEE IT. This is the moment the draft's
    // link is pointed at the published dashboard, so it is the moment the
    // published dashboard takes the draft's audience: the same private-or-open
    // setting, and the same people.
    //
    // The setting is written even when the draft is open, so it also overrides
    // a `private` tag in the promoted file — the draft's audience is what
    // people were promised, not whatever the file happens to say.
    //
    // A name that is itself a draft's is not a published dashboard; nothing to copy to.
    if (promoted.name === draftName) return;
    await tx
      .update(datasets)
      .set({
        dashboardAudience: sql`jsonb_set(${datasets.dashboardAudience}, array[${promoted.name}]::text[], to_jsonb(${row.visibility}::text))`,
      })
      .where(eq(datasets.id, row.datasetId));
    await tx.execute(sql`
      insert into ${dashboardGrants} (dataset_id, dashboard, user_id, granted_by_id)
      select dataset_id, ${promoted.name}, user_id, granted_by_id
        from ${dashboardGrants}
       where dataset_id = ${row.datasetId}::uuid and dashboard = ${draftName}
      on conflict do nothing`);
    // A draft's author sees it because it is theirs. A published dashboard has
    // no author, so a private one would vanish from the person who built it the
    // day it shipped. They are added as one of its people instead.
    if (row.visibility === "private") {
      await tx
        .insert(dashboardGrants)
        .values({ datasetId: row.datasetId, dashboard: promoted.name, userId: row.userId, grantedById: row.userId })
        .onConflictDoNothing();
    }
  });
  return "recorded";
}

/** The CLI's hash shape (sha256 over each file then a NUL, first 16 hex), over the draft's own files. */
function draftHash(row: { malloy: string; source: string }): string {
  const hash = createHash("sha256");
  for (const content of [row.malloy, row.source]) if (content.trim()) hash.update(content).update("\0");
  return hash.digest("hex").slice(0, 16);
}

/**
 * Delete a draft. Its author may, and so may an admin — a draft opened to the
 * dataset is everyone's clutter once it is stale, and someone has to be able
 * to clear it.
 *
 * A real delete: the row goes, and its URL 404s. A promoted draft whose
 * dashboard is published doesn't need deleting — listings already leave it
 * out and its URL forwards — and deleting it gives up that forward, which is
 * why the result says so.
 */
export async function deleteDraft(
  user: RoleBearing & { id: string },
  datasetRef: string,
  slug: string,
): Promise<{ outcome: "deleted"; promotedAs: string | null } | { outcome: "not-found" | "not-yours" }> {
  const found = await findByDatasetRef(user.id, datasetRef, "view");
  if (!found) return { outcome: "not-found" };
  const [row] = await db
    .select()
    .from(draftDashboards)
    .where(and(eq(draftDashboards.slug, slug), eq(draftDashboards.datasetId, found.ds.id)))
    .limit(1);
  if (!row) return { outcome: "not-found" };
  if (row.userId !== user.id && !hasRole(user, MALLOYYO_ADMIN)) return { outcome: "not-yours" };
  // Its shares go with it. They are keyed by name, not by this row, so nothing
  // cascades — and a slug is never reused, so they would only ever be litter.
  await db.transaction(async (tx) => {
    await tx
      .delete(dashboardGrants)
      .where(
        and(eq(dashboardGrants.datasetId, row.datasetId), eq(dashboardGrants.dashboard, `${DRAFT_PREFIX}${row.slug}`)),
      );
    await tx.delete(draftDashboards).where(eq(draftDashboards.id, row.id));
  });
  return { outcome: "deleted", promotedAs: row.promotedAs };
}
