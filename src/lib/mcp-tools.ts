// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { eq, and, desc, count } from "drizzle-orm";
import { db, datasets, malloyModels, savedQueries, history, favorites } from "@/db";
import type { SourceInfo } from "./malloy";
// NOTE: `runRestrictedMalloyFiles` (and everything under ./malloy) pulls in
// @malloydata/db-duckdb → @duckdb/node-api, whose native libduckdb.so loads at
// import time. It's imported LAZILY (dynamic import at the two call sites below)
// so modules that only READ the DB — notably loadSharedQuery, used by the
// /ltool/[slug] page — don't drag DuckDB into their serverless bundle and 500
// with "libduckdb.so: cannot open shared object file".
import { datasetVisibleWhere, rolesOf, type RoleBearing } from "./roles";
import { env } from "./env";
import { leaseScope } from "./tenancy";
import { parseSlug, instanceSlug } from "./slug";
import { logger, serializeErr } from "./logger";
import {
  captureTelemetry,
  historyTelemetryEvent,
  type QueryEntrypoint,
} from "./telemetry";

// NOTE: the MCP tool surface (tool descriptors, server instructions, and the
// callTool dispatcher) USED to live here. It has been deleted — the deployed
// /mcp now runs entirely on the mcp-engine exploreSurface, wired in
// src/lib/mcp-host.ts. What remains here is the DB/query plumbing that the host
// (and the web UI) share: model resolution, file maps, recording, sharing.

// The datasets a user may query: their own or public, and ready. One home for
// the predicate — the host's findModelByRef and findBySource both build on it.
export function visibleDatasetWhere(userId: string, isAdmin = false) {
  // Owner, public, granted by a role — or MALLOYYO_ADMIN, which opens every
  // dataset. Kept as a re-export rather than inlined because every read path in
  // the app funnels through this name, and one predicate is the only way that
  // stays true.
  return datasetVisibleWhere(userId, isAdmin);
}

// What a viewer may READ ABOUT a dataset: the questions asked of it, the Malloy
// those questions produced, a chat scoped to it. Deliberately a different rule
// from visibleDatasetWhere above, which decides what may be RUN.
//
// Running returns ROWS, so it is owner-or-public with no admin exemption — an
// admin does not get to query a private dataset just for being an admin.
// Reading returns a question and a query, which is how an operator answers
// "what is this instance being used for", so an admin does see everything.
//
// Between those two sits the thing that made this necessary: a question and its
// Malloy name the private model's fields, its filters, and what someone wanted
// to know. That is not nothing, and it was visible to every signed-in user.
export function canReadDataset(
  ds: { isPublic: boolean; userId: string | null },
  viewerId: string,
  admin: boolean,
): boolean {
  return admin || ds.isPublic || ds.userId === viewerId;
}

// Normalize DB sources column — legacy string[] or new {name, description?}[] format.
export function normalizeSources(raw: unknown): SourceInfo[] {
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

/**
 * Resolve a dataset a USER may query, by the ordered rule in src/lib/repos.ts.
 *
 * Resolution and visibility are separate steps on purpose: resolving by name has
 * to give the same answer for everyone, or two people following the same share
 * link reach different datasets. So the ref is resolved first and the viewer's
 * visibility is applied to the answer.
 */
export async function findByDatasetRef(userId: string, ref: string) {
  const { resolveDatasetRef } = await import("./repos");
  const r = await resolveDatasetRef(ref);
  if (!r.ok) return null;
  const [visible] = await db
    .select()
    .from(datasets)
    .where(and(visibleDatasetWhere(userId), eq(datasets.id, r.dataset.id)))
    .limit(1);
  if (!visible) return null;
  const model = await latestModel(visible.id);
  if (!model) return null;
  return { ds: visible, model, description: null as string | null };
}

/**
 * Dataset resolution for the publish API (push/status), by the ordered rule in
 * src/lib/repos.ts: a uuid, then `repo:dataset`, then an ALIAS (every
 * pre-existing name, pinned), then a repo-less name, then a bare name unique
 * across repos - and an ambiguous bare name is refused, never guessed.
 *
 * NOT user-scoped: the caller has already authorized with a publish bearer, and
 * the route applies the owner gate itself.
 */
export async function resolveDatasetByRef(ref: string) {
  const { resolveDatasetRef } = await import("./repos");
  const r = await resolveDatasetRef(ref);
  return r.ok ? r.dataset : null;
}


export async function latestModel(datasetId: string) {
  const [active] = await db
    .select()
    .from(malloyModels)
    .where(and(eq(malloyModels.datasetId, datasetId), eq(malloyModels.active, true)))
    .limit(1);
  if (active) return active;
  const [row] = await db
    .select()
    .from(malloyModels)
    .where(eq(malloyModels.datasetId, datasetId))
    .orderBy(desc(malloyModels.version), desc(malloyModels.createdAt))
    .limit(1);
  return row;
}

/**
 * THE FILES A MODEL IS SERVED FROM.
 *
 * For a revision-backed model these come out of the revision's zip, derived by
 * the same `datasetView` rule the compile workspace was built from - so there is
 * one record of the repo's bytes rather than a zip and a per-file table that can
 * disagree. For everything else (a Claude-authored model, a single-dataset
 * `--dataset x` push) the stored rows are still the record, so nothing
 * historical had to be rewritten.
 *
 * `repoDir` is needed to pick the dataset's slice of the repo. Callers that hold
 * the dataset row pass it; the default is the repo root, which is every
 * single-dataset repo and every model that has no revision at all.
 */
export async function modelFileMap(
  /**
   * A `malloy_models` row. `revisionId` and `datasetId` are REQUIRED, not
   * optional-with-a-default: a call that omits them for a revision-backed model
   * would silently get the repo ROOT's view, and the symptom is a compile error
   * about a missing `index.malloy` rather than anything naming the mistake.
   * Every caller holds the whole row anyway.
   */
  model: { id: string; source: string; revisionId: string | null; datasetId: string },
  /** The dataset's directory in the repo. Looked up from the model's dataset
      when the caller does not hold it, so the call sites did not each have to
      grow a parameter they would sometimes get wrong. */
  repoDir?: string,
): Promise<Map<string, string>> {
  const { modelFilesFor } = await import("./repo-files");
  let dir = repoDir;
  if (dir === undefined && model.revisionId) {
    const [ds] = await db
      .select({ repoDir: datasets.repoDir })
      .from(datasets)
      .where(eq(datasets.id, model.datasetId))
      .limit(1);
    dir = ds?.repoDir ?? "";
  }
  return modelFilesFor(
    { id: model.id, source: model.source, revisionId: model.revisionId ?? null },
    dir ?? "",
  );
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
  entrypoint?: QueryEntrypoint;
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
  let recordedSlug: string | null = null;
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
    recordedSlug = slug;
  } catch (e) {
    logger.error("history insert failed", {
      toolName: fields.toolName,
      userId: fields.userId,
      error: serializeErr(e).message,
    });
  }
  captureHistoryTelemetry(fields);
  return { slug: recordedSlug };
}

function captureHistoryTelemetry(fields: RecordHistoryFields): void {
  const event = historyTelemetryEvent(fields);
  if (event) void captureTelemetry(event, fields.userId);
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
// `entrypoint` labels a runQueryForWeb run in `history` and defaults to
// 'ltool' — the Run button. Ask passes 'ask' so a query a model wrote for
// someone is countable apart from one they wrote themselves, which is the only
// way to tell whether a cheaper model is good enough at Malloy. saveWebQuery
// ignores it: saving is the Run & save button, full stop.
export type WebRunOpts = {
  userAgent?: string | null;
  authorModel?: string | null;
  question?: string | null;
  entrypoint?: QueryEntrypoint;
};

// Run a Malloy query for the web UI, recording it to history (a browser run —
// user_agent is the browser, author_model resolved by the caller). Every run is
// tracked, including re-runs and failures. Returns the full result plus the
// minted share slug so the UI row is shareable/favoritable.
export async function runQueryForWeb(
  // The whole user, not just the id: a model that declared
  // MALLOYYO_EMAIL binds their address, and it must come from the
  // session rather than anything in the request (src/lib/tenancy.ts).
  user: { id: string; email: string | null } & RoleBearing,
  source: string,
  malloyQuery: string,
  maxRows = 1000,
  datasetId?: string | null,
  opts: WebRunOpts = {},
): Promise<WebRunResult> {
  const userId = user.id;
  // When the caller knows the dataset (an ltool replay carries the recorded
  // dataset_id), resolve by it — unambiguous. Else fall back to source name.
  //
  // By REF, not by id: a recorded dataset_id is a uuid, but a link a person can
  // read carries the dataset's NAME (`/ltool?dataset=babynames`), and
  // findByDatasetRef takes either. Resolving only by id made a named link fail
  // in the ugliest way available — Postgres refusing to cast the name to uuid.
  const found = datasetId ? await findByDatasetRef(userId, datasetId) : await findBySource(userId, source);
  if (!found) return { ok: false, error: `source '${source}' not found` };
  const { ds, model } = found;
  if (ds.status !== "ready") return { ok: false, error: `source '${source}' is not ready` };
  const files = await modelFileMap(model);
  const t0 = Date.now();
  try {
    const { runRestrictedMalloyFiles } = await import("./malloy"); // lazy — see import note above
    const res = await runRestrictedMalloyFiles(files, "index.malloy", malloyQuery, {
      rowLimit: maxRows,
      cacheKey: model.id,
      // Identity on the runtime, and the names this query must reference.
      // Both from the dataset (src/lib/tenancy.ts) — never from the request.
      scope: leaseScope(ds.requiredGivens, { email: user.email, roles: rolesOf(user) }),
      requireGivens: ds.requiredGivens,
    });
    const durationMs = Date.now() - t0;
    const capped = res.rows.slice(0, maxRows);
    const { slug } = await recordHistory({
      userId, entrypoint: opts.entrypoint ?? "ltool", datasetId: ds.id, toolName: "query", question: opts.question ?? null,
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
      userId, entrypoint: opts.entrypoint ?? "ltool", datasetId: ds.id, toolName: "query", question: opts.question ?? null,
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
  // The whole user, not just the id: a model that declared
  // MALLOYYO_EMAIL binds their address, and it must come from the
  // session rather than anything in the request (src/lib/tenancy.ts).
  user: { id: string; email: string | null } & RoleBearing,
  source: string,
  malloyQuery: string,
  title: string,
  maxRows = 1000,
  datasetId?: string | null,
  opts: WebRunOpts = {},
): Promise<WebSaveResult> {
  const userId = user.id;
  // By ref, for the same reason as runQueryForWeb above.
  const found = datasetId ? await findByDatasetRef(userId, datasetId) : await findBySource(userId, source);
  if (!found) return { ok: false, error: `source '${source}' not found` };
  const { ds, model } = found;
  if (ds.status !== "ready") return { ok: false, error: `source '${source}' is not ready` };
  const files = await modelFileMap(model);

  const t0 = Date.now();
  try {
    const { runRestrictedMalloyFiles } = await import("./malloy"); // lazy — see import note above
    const res = await runRestrictedMalloyFiles(files, "index.malloy", malloyQuery, {
      rowLimit: maxRows,
      cacheKey: model.id,
      // Identity on the runtime, and the names this query must reference.
      // Both from the dataset (src/lib/tenancy.ts) — never from the request.
      scope: leaseScope(ds.requiredGivens, { email: user.email, roles: rolesOf(user) }),
      requireGivens: ds.requiredGivens,
    });
    const durationMs = Date.now() - t0;
    const capped = res.rows.slice(0, maxRows);
    // Saving is the Run & save button and nothing else, so the entrypoint here
    // is literal — deliberately NOT opts.entrypoint. The 'query saved'
    // telemetry event is typed to 'ltool' for the same reason. Give Ask a save
    // path one day and both widen together.
    const { slug } = await recordHistory({
      userId, entrypoint: "ltool", datasetId: ds.id, toolName: "query", question: title,
      source, malloyInput: malloyQuery, compiledSql: res.sql, rowCount: res.rowCount, durationMs,
      executed: true, userAgent: opts.userAgent, authorModel: opts.authorModel ?? "human", mintSlug: true,
    });
    const saved = slug ? await promoteToSaved(slug) : null;
    if (saved) {
      void captureTelemetry(
        { event: "query saved", properties: { entrypoint: "ltool" } },
        userId,
      );
    }
    return { ok: true, slug, rows: capped, sql: res.sql, rowCount: res.rowCount, truncated: res.rowCount > capped.length, durationMs, stableResult: res.stableResult };
  } catch (err) {
    const durationMs = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    await recordHistory({
      userId, entrypoint: "ltool", datasetId: ds.id, toolName: "query", question: title,
      source, malloyInput: malloyQuery, durationMs, executed: true, error: msg,
      userAgent: opts.userAgent, authorModel: opts.authorModel ?? "human",
    });
    return { ok: false, error: msg };
  }
}

/** A dataset's display name from its id, or null. For turning a STORED id (a
    recorded query's dataset_id) into the ref a link or a re-run should carry —
    ids belong to the database, not to URLs or to the browser. */
export async function datasetNameById(id: string): Promise<string | null> {
  if (!UUID_RE.test(id)) return id; // already a ref
  const [ds] = await db.select({ name: datasets.name }).from(datasets).where(eq(datasets.id, id)).limit(1);
  return ds?.name ?? null;
}
