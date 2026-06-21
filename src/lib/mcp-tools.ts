// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { eq, and, desc, or, count, isNull, inArray } from "drizzle-orm";
import { db, datasets, malloyModels, malloyModelFiles, queries, conversations, inquiries, toolCalls, favorites } from "@/db";
import type { SourceInfo } from "./malloy";
import { runMalloyFiles } from "./malloy";
import { env } from "./env";
import { parseSlug } from "./slug";
import { RUN_LABELS } from "./tool-names";

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

async function nextSequence(inquiryId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(toolCalls)
    .where(eq(toolCalls.inquiryId, inquiryId));
  return Number(row?.n ?? 0);
}

export async function logCall(fields: {
  inquiryId?: string;
  userId: string;
  datasetId?: string;
  toolName: string;
  source?: string;
  malloyInput?: string;
  compiledSql?: string;
  rowCount?: number;
  durationMs?: number;
  error?: string;
}) {
  const seq = fields.inquiryId ? await nextSequence(fields.inquiryId) : 0;
  await db.insert(toolCalls).values({ ...fields, sequence: seq }).catch(() => {});
}

// Find or create a conversation for auto-inquiry creation.
export async function ensureConversation(userId: string, conversationId: string | undefined, sourceName: string, datasetId: string | undefined): Promise<string> {
  if (conversationId) return conversationId;
  const [conv] = await db
    .insert(conversations)
    .values({ userId, datasetId, source: sourceName || undefined })
    .returning({ id: conversations.id });
  return conv.id;
}

export type SharedQuery =
  | { ok: true; instance: string; source: string | null; datasetId: string | null; question: string; malloy: string | null }
  | { ok: false; error: string; wrongInstance?: string };

// Resolve a share slug into the query it points at: the inquiry's question
// plus the source/Malloy from its most recent successful run. Shared by the
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
  const [inq] = await db.select({ id: inquiries.id, question: inquiries.question }).from(inquiries).where(eq(inquiries.slug, slug)).limit(1);
  if (!inq) return { ok: false, error: `query slug '${slug}' not found` };
  const [tc] = await db
    .select({ source: toolCalls.source, malloy: toolCalls.malloyInput, datasetId: toolCalls.datasetId })
    .from(toolCalls)
    .where(and(eq(toolCalls.inquiryId, inq.id), inArray(toolCalls.toolName, RUN_LABELS), isNull(toolCalls.error)))
    .orderBy(desc(toolCalls.createdAt))
    .limit(1);
  return { ok: true, instance: env.INSTANCE_NAME, source: tc?.source ?? null, datasetId: tc?.datasetId ?? null, question: inq.question, malloy: tc?.malloy ?? null };
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
  const [inq] = await db.select({ id: inquiries.id }).from(inquiries).where(eq(inquiries.slug, slug)).limit(1);
  if (!inq) return null;
  const [total] = await db.select({ n: count() }).from(favorites).where(eq(favorites.inquiryId, inq.id));
  const [mine] = await db.select({ n: count() }).from(favorites).where(and(eq(favorites.inquiryId, inq.id), eq(favorites.userId, userId)));
  const [authored] = await db
    .select({ n: count() })
    .from(toolCalls)
    .where(and(eq(toolCalls.inquiryId, inq.id), eq(toolCalls.userId, userId), inArray(toolCalls.toolName, RUN_LABELS), isNull(toolCalls.error)));
  return {
    favoriteCount: Number(total?.n ?? 0),
    favoritedByMe: Number(mine?.n ?? 0) > 0,
    authoredByMe: Number(authored?.n ?? 0) > 0,
  };
}

export type WebRunResult =
  | { ok: true; rows: Record<string, unknown>[]; sql: string; rowCount: number; truncated: boolean; durationMs: number; stableResult: unknown }
  | { ok: false; error: string };

// Run a Malloy query for the web UI. Returns the full result including the
// stable (interfaces-format) result for client-side Malloy rendering.
export async function runQueryForWeb(
  userId: string,
  source: string,
  malloyQuery: string,
  maxRows = 1000,
  datasetId?: string | null,
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
    const capped = res.rows.slice(0, maxRows);
    return {
      ok: true,
      rows: capped,
      sql: res.sql,
      rowCount: res.rowCount,
      truncated: res.rowCount > capped.length,
      durationMs: Date.now() - t0,
      stableResult: res.stableResult,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type WebSaveResult =
  | { ok: true; slug: string | null; inquiryId: string; rows: Record<string, unknown>[]; sql: string; rowCount: number; truncated: boolean; durationMs: number; stableResult: unknown }
  | { ok: false; error: string };

// Run a Malloy query from the web UI AND persist it as a new history entry:
// creates a conversation + inquiry (which mints a fresh slug) and logs a
// query tool call so it shows up in /ltool history and is shareable. Used
// when the user edits a loaded query and runs it (the slug no longer matches
// the original, so it becomes a new saved query).
export async function saveWebQuery(
  userId: string,
  source: string,
  malloyQuery: string,
  title: string,
  maxRows = 1000,
  datasetId?: string | null,
): Promise<WebSaveResult> {
  const found = datasetId ? await findByDatasetId(userId, datasetId) : await findBySource(userId, source);
  if (!found) return { ok: false, error: `source '${source}' not found` };
  const { ds, model } = found;
  if (ds.status !== "ready") return { ok: false, error: `source '${source}' is not ready` };
  const files = await modelFileMap(model);

  const convId = await ensureConversation(userId, undefined, source, ds.id);
  const [seq] = await db.select({ n: count() }).from(inquiries).where(eq(inquiries.conversationId, convId));
  const [inq] = await db
    .insert(inquiries)
    .values({ conversationId: convId, question: title, sequence: Number(seq?.n ?? 0) })
    .returning({ id: inquiries.id, slug: inquiries.slug });

  const t0 = Date.now();
  try {
    const res = await runMalloyFiles(files, "index.malloy", malloyQuery, { rowLimit: maxRows, cacheKey: model.id });
    const durationMs = Date.now() - t0;
    const capped = res.rows.slice(0, maxRows);
    await db.insert(queries).values({ datasetId: ds.id, userId, malloySource: malloyQuery, compiledSql: res.sql, rowCount: res.rowCount, durationMs });
    await logCall({ inquiryId: inq.id, userId, datasetId: ds.id, toolName: "query", source, malloyInput: malloyQuery, compiledSql: res.sql, rowCount: res.rowCount, durationMs });
    return { ok: true, slug: inq.slug, inquiryId: inq.id, rows: capped, sql: res.sql, rowCount: res.rowCount, truncated: res.rowCount > capped.length, durationMs, stableResult: res.stableResult };
  } catch (err) {
    const durationMs = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    await db.insert(queries).values({ datasetId: ds.id, userId, malloySource: malloyQuery, error: msg });
    await logCall({ inquiryId: inq.id, userId, datasetId: ds.id, toolName: "query", source, malloyInput: malloyQuery, error: msg, durationMs });
    return { ok: false, error: msg };
  }
}
