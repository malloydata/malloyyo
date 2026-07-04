// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { eq, and, desc, or, count } from "drizzle-orm";
import { db, datasets, malloyModels, malloyModelFiles, savedQueries, history, favorites } from "@/db";
import type { SourceInfo } from "./malloy";
import { runMalloyFiles } from "./malloy";
import { env } from "./env";
import { parseSlug, instanceSlug } from "./slug";
import { logger, serializeErr } from "./logger";

// NOTE: the MCP tool surface (tool descriptors, server instructions, and the
// callTool dispatcher) USED to live here. It has been deleted — the deployed
// /mcp now runs entirely on the mcp-engine exploreSurface, wired in
// src/lib/mcp-host.ts. What remains here is the DB/query plumbing that the host
// (and the web UI) share: model resolution, file maps, recording, sharing.

// The datasets a user may query: their own or public, and ready. One home for
// the predicate — the host's findModelByRef and findBySource both build on it.
export function visibleDatasetWhere(userId: string) {
  return and(
    or(eq(datasets.userId, userId), eq(datasets.isPublic, true)),
    eq(datasets.status, "ready"),
  );
}

// Normalize DB sources column — legacy string[] or new {name, description?}[] format.
function normalizeSources(raw: unknown): SourceInfo[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((s) =>
    typeof s === "string" ? { name: s, description: null } : { name: String(s.name), description: s.description ?? null }
  );
}

export async function findBySource(userId: string, sourceName: string) {
  const dsList = await db
    .select()
    .from(datasets)
    .where(visibleDatasetWhere(userId))
    .orderBy(desc(datasets.createdAt));

  for (const ds of dsList) {
    const model = await latestModel(ds.id);
    if (!model) continue;
    const sources = normalizeSources(model.sources);
    const names = sources.map((s) => s.name);
    if (names.includes(sourceName) || (names.length === 0 && ds.name === sourceName) || (names.length === 1 && ds.name === sourceName)) {
      const description = sources.find((s) => s.name === sourceName)?.description ?? null;
      return { ds, model, description };
    }
  }
  return null;
}

/** Resolve a dataset directly by id (with visibility). Unambiguous — used by the
    ltool replay, where the recorded `dataset_id` already names the exact model,
    so we don't re-guess from a (possibly ambiguous) source name. */
export async function findByDatasetId(userId: string, datasetId: string) {
  const [ds] = await db
    .select()
    .from(datasets)
    .where(and(visibleDatasetWhere(userId), eq(datasets.id, datasetId)))
    .limit(1);
  if (!ds) return null;
  const model = await latestModel(ds.id);
  if (!model) return null;
  return { ds, model, description: null as string | null };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve a dataset by id (uuid) OR by name — the ready dataset with that name,
    which is unique on the server. Lets URLs use the readable name while old
    uuid links keep working. */
export async function findByDatasetRef(userId: string, ref: string) {
  if (UUID_RE.test(ref)) return findByDatasetId(userId, ref);
  const [ds] = await db
    .select()
    .from(datasets)
    .where(and(visibleDatasetWhere(userId), eq(datasets.name, ref)))
    .limit(1);
  if (!ds) return null;
  const model = await latestModel(ds.id);
  if (!model) return null;
  return { ds, model, description: null as string | null };
}

export async function latestModel(datasetId: string) {
  const [row] = await db
    .select()
    .from(malloyModels)
    .where(eq(malloyModels.datasetId, datasetId))
    .orderBy(desc(malloyModels.createdAt))
    .limit(1);
  return row;
}

export async function modelFileMap(model: { id: string; source: string }): Promise<Map<string, string>> {
  const files = await db
    .select({ path: malloyModelFiles.path, content: malloyModelFiles.content })
    .from(malloyModelFiles)
    .where(eq(malloyModelFiles.modelId, model.id));
  if (files.length > 0) {
    return new Map(files.map((f) => [f.path, f.content]));
  }
  return new Map([["index.malloy", model.source]]);
}

// Time-window sessionization: consecutive activity by one user rolls into a
// session; a gap longer than this starts a new one. Keyed on the USER only (not
// user+dataset) so a single exploration groups together — list_sources and
// describe_source carry no dataset_id, so keying on dataset would split them off
// from the queries they set up. MCP is stateless per request, so we derive the
// session from the user's last recorded row rather than threading a session id
// through the agent (which is unreliable).
const SESSION_WINDOW_MS = 30 * 60 * 1000;

async function resolveSession(userId: string): Promise<{ sessionId: string; sequence: number }> {
  const [last] = await db
    .select({ sessionId: history.sessionId, createdAt: history.createdAt })
    .from(history)
    .where(eq(history.userId, userId))
    .orderBy(desc(history.createdAt))
    .limit(1);
  if (last?.sessionId && Date.now() - new Date(last.createdAt).getTime() < SESSION_WINDOW_MS) {
    const [seq] = await db.select({ n: count() }).from(history).where(eq(history.sessionId, last.sessionId));
    return { sessionId: last.sessionId, sequence: Number(seq?.n ?? 0) };
  }
  return { sessionId: crypto.randomUUID(), sequence: 0 };
}

export type RecordHistoryFields = {
  userId: string;
  datasetId?: string | null;
  toolName: string;
  question?: string | null;
  source?: string | null;
  malloyInput?: string | null;
  compiledSql?: string | null;
  rowCount?: number | null;
  durationMs?: number | null;
  executed?: boolean | null;
  error?: string | null;
  userAgent?: string | null;
  authorModel?: string | null;
  // Mint a shareable slug (successful runs only). Returned so the caller can
  // build the ltool link.
  mintSlug?: boolean;
};

// The single writer for the activity log. Every MCP tool call and every ltool
// run funnels through here, so nothing completes unrecorded — validate-only and
// failed attempts included. Never throws: a failed audit insert must not break
// the call it records (but it IS surfaced to the logger).
export async function recordHistory(fields: RecordHistoryFields): Promise<{ slug: string | null }> {
  try {
    const datasetId = fields.datasetId ?? null;
    const { sessionId, sequence } = await resolveSession(fields.userId);
    const slug = fields.mintSlug ? instanceSlug() : null;
    await db.insert(history).values({
      sessionId,
      sequence,
      userId: fields.userId,
      datasetId,
      toolName: fields.toolName,
      question: fields.question ?? null,
      source: fields.source ?? null,
      malloyInput: fields.malloyInput ?? null,
      compiledSql: fields.compiledSql ?? null,
      rowCount: fields.rowCount ?? null,
      durationMs: fields.durationMs ?? null,
      executed: fields.executed ?? null,
      error: fields.error ?? null,
      userAgent: fields.userAgent ?? null,
      authorModel: fields.authorModel ?? null,
      slug,
    });
    return { slug };
  } catch (e) {
    logger.error("history insert failed", {
      toolName: fields.toolName,
      userId: fields.userId,
      error: serializeErr(e).message,
    });
    return { slug: null };
  }
}

// Promote a shareable run (by its history slug) into a durable saved_query, or
// return the existing one. Idempotent by slug — used when a run is favorited or
// explicitly saved.
export async function promoteToSaved(slug: string): Promise<{ id: string } | null> {
  const [existing] = await db.select({ id: savedQueries.id }).from(savedQueries).where(eq(savedQueries.slug, slug)).limit(1);
  if (existing) return existing;
  const [h] = await db.select().from(history).where(eq(history.slug, slug)).limit(1);
  if (!h || !h.datasetId || !h.malloyInput) return null;
  const [row] = await db
    .insert(savedQueries)
    .values({
      slug,
      datasetId: h.datasetId,
      userId: h.userId,
      source: h.source,
      question: h.question ?? h.source ?? "query",
      malloySource: h.malloyInput,
      compiledSql: h.compiledSql,
      authorModel: h.authorModel,
    })
    .returning({ id: savedQueries.id });
  return row ?? null;
}

// ltool authorship: 'human' unless the editor ran a query loaded from a slug and
// left it byte-for-byte (whitespace-normalized) unmodified, in which case the
// original author is inherited. Server-side diff so the label is trustworthy.
export async function resolveLtoolAuthor(baseSlug: string | null | undefined, malloy: string): Promise<string> {
  if (!baseSlug) return "human";
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const [sq] = await db
    .select({ malloy: savedQueries.malloySource, authorModel: savedQueries.authorModel })
    .from(savedQueries)
    .where(eq(savedQueries.slug, baseSlug))
    .limit(1);
  if (sq) return norm(sq.malloy) === norm(malloy) ? (sq.authorModel ?? "human") : "human";
  const [h] = await db
    .select({ malloy: history.malloyInput, authorModel: history.authorModel })
    .from(history)
    .where(eq(history.slug, baseSlug))
    .limit(1);
  if (h?.malloy != null && norm(h.malloy) === norm(malloy)) return h.authorModel ?? "human";
  return "human";
}

export type SharedQuery =
  | { ok: true; instance: string; source: string | null; datasetId: string | null; question: string; malloy: string | null }
  | { ok: false; error: string; wrongInstance?: string };

// Resolve a share slug into the query it points at. Durable saved_queries win;
// otherwise the ephemeral history run that minted the slug. Shared by the
// open_share_link tool and the /api/ltool/share web endpoint.
export async function loadSharedQuery(slug: string): Promise<SharedQuery> {
  const parsed = parseSlug(slug);
  if (parsed && !parsed.matchesInstance) {
    return {
      ok: false,
      wrongInstance: parsed.code,
      error: `Slug '${slug}' belongs to the '${parsed.code}' Malloyyo instance, not '${env.INSTANCE_CODE}' (${env.INSTANCE_NAME}). Use that instance's tools instead.`,
    };
  }
  const [sq] = await db
    .select({ source: savedQueries.source, malloy: savedQueries.malloySource, datasetId: savedQueries.datasetId, question: savedQueries.question })
    .from(savedQueries)
    .where(eq(savedQueries.slug, slug))
    .limit(1);
  if (sq) {
    return { ok: true, instance: env.INSTANCE_NAME, source: sq.source, datasetId: sq.datasetId, question: sq.question, malloy: sq.malloy };
  }
  const [h] = await db
    .select({ source: history.source, malloy: history.malloyInput, datasetId: history.datasetId, question: history.question })
    .from(history)
    .where(eq(history.slug, slug))
    .limit(1);
  if (!h) return { ok: false, error: `query slug '${slug}' not found` };
  return { ok: true, instance: env.INSTANCE_NAME, source: h.source, datasetId: h.datasetId, question: h.question ?? "", malloy: h.malloy };
}

export type SharedQueryListContext = {
  favoritedByMe: boolean;
  favoriteCount: number;
  authoredByMe: boolean;
};

// For the ltool deep-link: where the shared query lives from the viewer's
// perspective, so the page can open on a tab/scope that actually contains it.
// `authoredByMe` mirrors the history "me" filter (a successful run logged by
// this user). Returns null if the slug isn't found.
export async function sharedQueryListContext(slug: string, userId: string): Promise<SharedQueryListContext | null> {
  const [sq] = await db.select({ id: savedQueries.id }).from(savedQueries).where(eq(savedQueries.slug, slug)).limit(1);
  let favoriteCount = 0;
  let favoritedByMe = false;
  if (sq) {
    const [total] = await db.select({ n: count() }).from(favorites).where(eq(favorites.savedQueryId, sq.id));
    const [mine] = await db.select({ n: count() }).from(favorites).where(and(eq(favorites.savedQueryId, sq.id), eq(favorites.userId, userId)));
    favoriteCount = Number(total?.n ?? 0);
    favoritedByMe = Number(mine?.n ?? 0) > 0;
  }
  // Authored = this user has a run of this slug in their history.
  const [authored] = await db
    .select({ n: count() })
    .from(history)
    .where(and(eq(history.slug, slug), eq(history.userId, userId)));
  return {
    favoriteCount,
    favoritedByMe,
    authoredByMe: Number(authored?.n ?? 0) > 0,
  };
}

export type WebRunResult =
  | { ok: true; slug: string | null; rows: Record<string, unknown>[]; sql: string; rowCount: number; truncated: boolean; durationMs: number; stableResult: unknown }
  | { ok: false; error: string };

// Context for a web run: the client (User-Agent), the resolved author_model
// ('human' or an inherited model), and the loaded query's question, if any.
export type WebRunOpts = { userAgent?: string | null; authorModel?: string | null; question?: string | null };

// Run a Malloy query for the web UI, recording it to history (a browser run —
// user_agent is the browser, author_model resolved by the caller). Every run is
// tracked, including re-runs and failures. Returns the full result plus the
// minted share slug so the UI row is shareable/favoritable.
export async function runQueryForWeb(
  userId: string,
  source: string,
  malloyQuery: string,
  maxRows = 1000,
  datasetId?: string | null,
  opts: WebRunOpts = {},
): Promise<WebRunResult> {
  // When the caller knows the dataset (an ltool replay carries the recorded
  // dataset_id), resolve by it — unambiguous. Else fall back to source name.
  const found = datasetId ? await findByDatasetId(userId, datasetId) : await findBySource(userId, source);
  if (!found) return { ok: false, error: `source '${source}' not found` };
  const { ds, model } = found;
  if (ds.status !== "ready") return { ok: false, error: `source '${source}' is not ready` };
  const files = await modelFileMap(model);
  const t0 = Date.now();
  try {
    const res = await runMalloyFiles(files, "index.malloy", malloyQuery, { rowLimit: maxRows, cacheKey: model.id });
    const durationMs = Date.now() - t0;
    const capped = res.rows.slice(0, maxRows);
    const { slug } = await recordHistory({
      userId, datasetId: ds.id, toolName: "query", question: opts.question ?? null,
      source, malloyInput: malloyQuery, compiledSql: res.sql, rowCount: res.rowCount, durationMs,
      executed: true, userAgent: opts.userAgent, authorModel: opts.authorModel, mintSlug: true,
    });
    return {
      ok: true,
      slug,
      rows: capped,
      sql: res.sql,
      rowCount: res.rowCount,
      truncated: res.rowCount > capped.length,
      durationMs,
      stableResult: res.stableResult,
    };
  } catch (err) {
    const durationMs = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    await recordHistory({
      userId, datasetId: ds.id, toolName: "query", question: opts.question ?? null,
      source, malloyInput: malloyQuery, durationMs, executed: true, error: msg,
      userAgent: opts.userAgent, authorModel: opts.authorModel,
    });
    return { ok: false, error: msg };
  }
}

export type WebSaveResult =
  | { ok: true; slug: string | null; rows: Record<string, unknown>[]; sql: string; rowCount: number; truncated: boolean; durationMs: number; stableResult: unknown }
  | { ok: false; error: string };

// Run a Malloy query from the web UI AND persist it as a durable saved_query:
// records the run to history (minting a slug), then promotes that slug into
// saved_queries so it survives history trimming and is shareable/favoritable.
// Used when the user edits a loaded query and runs it (author_model = 'human').
export async function saveWebQuery(
  userId: string,
  source: string,
  malloyQuery: string,
  title: string,
  maxRows = 1000,
  datasetId?: string | null,
  opts: WebRunOpts = {},
): Promise<WebSaveResult> {
  const found = datasetId ? await findByDatasetId(userId, datasetId) : await findBySource(userId, source);
  if (!found) return { ok: false, error: `source '${source}' not found` };
  const { ds, model } = found;
  if (ds.status !== "ready") return { ok: false, error: `source '${source}' is not ready` };
  const files = await modelFileMap(model);

  const t0 = Date.now();
  try {
    const res = await runMalloyFiles(files, "index.malloy", malloyQuery, { rowLimit: maxRows, cacheKey: model.id });
    const durationMs = Date.now() - t0;
    const capped = res.rows.slice(0, maxRows);
    const { slug } = await recordHistory({
      userId, datasetId: ds.id, toolName: "query", question: title,
      source, malloyInput: malloyQuery, compiledSql: res.sql, rowCount: res.rowCount, durationMs,
      executed: true, userAgent: opts.userAgent, authorModel: opts.authorModel ?? "human", mintSlug: true,
    });
    if (slug) await promoteToSaved(slug);
    return { ok: true, slug, rows: capped, sql: res.sql, rowCount: res.rowCount, truncated: res.rowCount > capped.length, durationMs, stableResult: res.stableResult };
  } catch (err) {
    const durationMs = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    await recordHistory({
      userId, datasetId: ds.id, toolName: "query", question: title,
      source, malloyInput: malloyQuery, durationMs, executed: true, error: msg,
      userAgent: opts.userAgent, authorModel: opts.authorModel ?? "human",
    });
    return { ok: false, error: msg };
  }
}
