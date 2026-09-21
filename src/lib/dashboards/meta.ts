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
import { db, datasets, malloyArtifacts, malloyModelFiles, draftDashboards, users } from "@/db";
import { visibleDatasetWhere, findByDatasetRef, latestModel } from "@/lib/mcp-tools";
import { aboutFirst } from "./about";
import { imageHostsFromConfig } from "./image-hosts";

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
  /** A draft, not a dashboard the model publishes. */
  isDraft?: boolean;
  /** Who made it — drafts only, where "whose is this?" is the first question.
      A published dashboard's author is in the repo's history instead. */
  author?: string;
  /** Its author's id, so a caller can tell a reader's own from everyone else's. */
  authorId?: string;
}

export interface DashboardDetail extends DashboardSummary {
  manifest: Record<string, unknown>;
  source: string;
  modelId: string;
  /** Set for a draft dashboard: its own files, laid over the model's, and a
      version that changes on every save (the runtime cache key must, too). */
  draft?: { id: string; files: Record<string, string>; version: string };
}

/** Draft dashboards are addressed as `draft-<slug>` wherever a dashboard
    name goes, so every dashboard route serves them without knowing about them. */
export const DRAFT_PREFIX = "draft-";

export function draftSlug(name: string): string | null {
  return name.startsWith(DRAFT_PREFIX) ? name.slice(DRAFT_PREFIX.length) : null;
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

/** Dashboards on ONE model version, addressed by model id.
 *
 * For a caller that has already resolved the dataset and picked the model
 * version — the MCP catalog listing walks every visible dataset and leases each
 * one's latest model, so it is holding both. Going back through
 * `findByDatasetRef` there would re-select the dataset and re-pick the latest
 * model per dataset, and the re-pick can land on a NEWER version than the one
 * the caller is describing, listing v(n+1)'s dashboards beside v(n)'s sources.
 *
 * Takes no userId and does NO visibility check: the model id is the
 * authorization. Only call it with a model the caller has already established
 * the user may see — `listDashboards` below is the checked entry point. */
export async function listDashboardsForModel(
  modelId: string,
  datasetId: string,
  datasetName: string,
): Promise<DashboardSummary[]> {
  const rows = await artifactsForModel(modelId);
  return rows.map((a) => summary(datasetId, datasetName, a));
}

/** Dashboards on a single dataset's current (latest) model, if visible. */
export async function listDashboards(userId: string, datasetId: string): Promise<DashboardSummary[]> {
  const found = await findByDatasetRef(userId, datasetId);
  if (!found) return [];
  return listDashboardsForModel(found.model.id, datasetId, found.ds.name);
}

/** One dataset's dashboards AND the drafts people made on it — what the home
    page and a dataset's nav both show. Separate from `listDashboards`, which
    stays the model's own: a draft is not a sibling of a published dashboard
    (the frame injects that list into a dashboard's own switcher). */
export async function listDashboardsAndDrafts(userId: string, datasetRef: string): Promise<DashboardSummary[]> {
  const found = await findByDatasetRef(userId, datasetRef);
  if (!found) return [];
  return [
    ...(await listDashboardsForModel(found.model.id, found.ds.id, found.ds.name)),
    ...(await listDraftsOnDataset(found.ds.id, found.ds.name)),
  ];
}

/** Every visible dataset's current dashboards — for the home page. */
export async function listAllDashboards(userId: string): Promise<DashboardSummary[]> {
  const dsList = await db.select().from(datasets).where(visibleDatasetWhere(userId)).orderBy(desc(datasets.createdAt));
  const out: DashboardSummary[] = [];
  for (const ds of dsList) {
    const model = await latestModel(ds.id);
    if (!model) continue;
    for (const d of await listDashboardsForModel(model.id, ds.id, ds.name)) out.push(d);
    for (const d of await listDraftsOnDataset(ds.id, ds.name)) out.push(d);
  }
  return out;
}

/**
 * Every draft on one dataset, newest first — carrying its author, because a
 * draft is someone's work in progress and "whose?" is the first question a
 * reader has. Listed to everyone who can see the dataset, which is the same
 * rule its URL already follows (and the rule the dataset's own dashboards
 * follow).
 */
export async function listDraftsOnDataset(datasetId: string, datasetName: string): Promise<DashboardSummary[]> {
  const rows = await db
    .select({ draft: draftDashboards, authorName: users.name, authorEmail: users.email })
    .from(draftDashboards)
    .leftJoin(users, eq(users.id, draftDashboards.userId))
    .where(eq(draftDashboards.datasetId, datasetId))
    .orderBy(desc(draftDashboards.updatedAt));
  return rows.map(({ draft: r, authorName, authorEmail }) => {
    const description = r.manifest?.description;
    return {
      datasetId,
      datasetName,
      name: `${DRAFT_PREFIX}${r.slug}`,
      title: r.title ?? r.name,
      ...(typeof description === "string" && description ? { description } : {}),
      isDraft: true,
      author: authorName || authorEmail || "unknown",
      authorId: r.userId,
    };
  });
}

export async function getDashboard(userId: string, datasetId: string, name: string): Promise<DashboardDetail | null> {
  const found = await findByDatasetRef(userId, datasetId);
  if (!found) return null;
  const slug = draftSlug(name);
  if (slug !== null) {
    // Visibility is the dataset's (checked above); the slug must belong to it.
    const [s] = await db
      .select()
      .from(draftDashboards)
      .where(and(eq(draftDashboards.slug, slug), eq(draftDashboards.datasetId, found.ds.id)))
      .limit(1);
    if (!s) return null;
    const entryFile = typeof s.manifest.entryFile === "string" ? s.manifest.entryFile : `dashboards/${s.name}.malloy`;
    return {
      datasetId,
      datasetName: found.ds.name,
      name,
      title: s.title ?? s.name,
      manifest: s.manifest,
      source: s.source,
      // Pinned: a draft dashboard runs against the model version it was
      // built on, not whatever the dataset has moved to since.
      modelId: s.modelId,
      // A component-only draft has no dashboard file to lay over the model.
      draft: {
        id: s.id,
        files: s.malloy.trim() ? { [entryFile]: s.malloy } : {},
        version: s.updatedAt.toISOString(),
      },
    };
  }
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

/**
 * Every image host declared by a model this user can see, as `https://host`
 * tokens (wildcards included) — the CSP the MCP App panel must carry for a
 * dashboard's `<img src>` to load inside it.
 *
 * The panel is ONE resource for every dashboard, so it cannot carry one
 * dashboard's hosts: it carries the union, which is the same set the web app
 * would allow this user across the dashboards they can open. Each entry was
 * validated on the way in (see ./image-hosts — the values come from a repo's
 * malloy-config.json and end up in a policy).
 *
 * One query per visible dataset, so it is called from `resources/read` (rare,
 * and cached by the client) rather than per tool call.
 */
export async function visibleImageHosts(userId: string, max = 16): Promise<string[]> {
  const dsList = await db.select().from(datasets).where(visibleDatasetWhere(userId));
  const hosts = new Set<string>();
  for (const ds of dsList) {
    const model = await latestModel(ds.id);
    if (!model) continue;
    for (const host of imageHostsFromConfig(await modelConfigJson(model.id))) {
      hosts.add(host);
      if (hosts.size >= max) return [...hosts];
    }
  }
  return [...hosts];
}
