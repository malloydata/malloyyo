// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { eq, desc, and, isNull, isNotNull, inArray, sql } from "drizzle-orm";
import { db, datasets, history, savedQueries, users } from "@/db";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { RUN_LABELS } from "@/lib/tool-names";

// --- favorites view: sourced from the DURABLE saved_queries, so favorites keep
// showing even after their history rows are trimmed (history is disposable). ---
function sqFavByMe(userId: string) {
  return sql<boolean>`EXISTS (SELECT 1 FROM favorites f WHERE f.saved_query_id = ${savedQueries.id} AND f.user_id = ${userId}::uuid)`;
}
function sqAnyFav() {
  return sql<boolean>`EXISTS (SELECT 1 FROM favorites f WHERE f.saved_query_id = ${savedQueries.id})`;
}
const sqFavCount = sql<number>`(SELECT count(*)::int FROM favorites f WHERE f.saved_query_id = ${savedQueries.id})`;

// --- history view: sourced from the activity log; a run is "favorited" when a
// saved_query with the same slug (promoted on favorite) is favorited by me. ---
function histFavByMe(userId: string) {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM favorites f JOIN saved_queries sq ON sq.id = f.saved_query_id
    WHERE sq.slug = ${history.slug} AND f.user_id = ${userId}::uuid
  )`;
}

export async function GET(req: Request) {
  let user;
  try { user = await getSessionUser(); } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "sign in required" }, { status: 401 });
    throw err;
  }

  const url = new URL(req.url);
  const scope = url.searchParams.get("scope") ?? "me";     // "me" | "all"
  const view  = url.searchParams.get("view")  ?? "history"; // "history" | "favorites"

  // `dataset=<id>` scopes to one dataset's Q&A: every author's answered
  // questions on it (the AI Q&A page). Overrides `scope`/`view` — it's a
  // dataset-wide view drawn from BOTH the disposable history log AND the durable
  // saved_queries, so questions survive history trimming (the same durable
  // source the front page reads).
  const datasetId = url.searchParams.get("dataset");
  if (datasetId) {
    return NextResponse.json(await datasetQuestions(datasetId));
  }

  if (view === "favorites") {
    const rows = await db
      .select({
        id: savedQueries.id,
        slug: savedQueries.slug,
        question: savedQueries.question,
        createdAt: savedQueries.createdAt,
        source: savedQueries.source,
        datasetId: savedQueries.datasetId,
        malloyQuery: savedQueries.malloySource,
        rowCount: sql<number | null>`null`,
        durationMs: sql<number | null>`null`,
        authorName: users.name,
        authorModel: savedQueries.authorModel,
        mine: sql<boolean>`${savedQueries.userId} = ${user.id}::uuid`,
        isFavorited: sqFavByMe(user.id),
        favoriteCount: sqFavCount,
      })
      .from(savedQueries)
      .leftJoin(users, eq(users.id, savedQueries.userId))
      // scope filters WHOSE favorites — mine vs anyone's.
      .where(scope === "me" ? sqFavByMe(user.id) : sqAnyFav())
      .orderBy(desc(savedQueries.createdAt))
      .limit(100);
    return NextResponse.json(rows);
  }

  // history view: recent successful, shareable runs (validate-only and failed
  // attempts are kept for analytics, not shown here).
  const rows = await db
    .select({
      id: history.id,
      slug: history.slug,
      question: history.question,
      createdAt: history.createdAt,
      source: history.source,
      datasetId: history.datasetId,
      malloyQuery: history.malloyInput,
      rowCount: history.rowCount,
      durationMs: history.durationMs,
      authorName: users.name,
      authorModel: history.authorModel,
      mine: sql<boolean>`${history.userId} = ${user.id}::uuid`,
      isFavorited: histFavByMe(user.id),
      favoriteCount: sql<number>`(
        SELECT count(*)::int FROM favorites f
        JOIN saved_queries sq ON sq.id = f.saved_query_id
        WHERE sq.slug = ${history.slug}
      )`,
    })
    .from(history)
    .leftJoin(users, eq(users.id, history.userId))
    .where(
      and(
        inArray(history.toolName, RUN_LABELS),
        eq(history.executed, true),
        isNull(history.error),
        isNotNull(history.slug),
        scope === "me" ? eq(history.userId, user.id) : undefined,
      )
    )
    .orderBy(desc(history.createdAt))
    .limit(100);

  return NextResponse.json(rows);
}

// One dataset's answered questions, merged from the disposable activity log
// (history — every asked question, incl. Claude's over MCP) and the durable
// saved_queries (favorited/saved ones that outlive history trimming). Deduped by
// slug (a saved query keeps its history slug), newest first — the same two
// tables ltool's History and Favorites views read. No favorite metadata: the AI
// Q&A page just lists questions and links each to its saved answer.
type DatasetQuestion = {
  slug: string | null;
  question: string | null;
  createdAt: Date;
  malloyQuery: string | null;
  rowCount: number | null;
  authorName: string | null;
  authorModel: string | null;
};

async function datasetQuestions(idOrName: string): Promise<DatasetQuestion[]> {
  // The route param may be a dataset UUID or its name (same as /api/datasets/[id])
  // — history/saved_queries key on the UUID, so resolve a name first.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrName);
  const [ds] = isUuid
    ? await db.select({ id: datasets.id }).from(datasets).where(eq(datasets.id, idOrName))
    : await db.select({ id: datasets.id }).from(datasets).where(and(eq(datasets.name, idOrName), eq(datasets.status, "ready")));
  if (!ds) return [];
  const datasetId = ds.id;

  const fromHistory = db
    .select({
      slug: history.slug,
      question: history.question,
      createdAt: history.createdAt,
      malloyQuery: history.malloyInput,
      rowCount: history.rowCount,
      authorName: users.name,
      authorModel: history.authorModel,
    })
    .from(history)
    .leftJoin(users, eq(users.id, history.userId))
    .where(
      and(
        eq(history.datasetId, datasetId),
        inArray(history.toolName, RUN_LABELS),
        eq(history.executed, true),
        isNull(history.error),
        isNotNull(history.slug),
      ),
    )
    .orderBy(desc(history.createdAt))
    .limit(200);

  const fromSaved = db
    .select({
      slug: savedQueries.slug,
      question: savedQueries.question,
      createdAt: savedQueries.createdAt,
      malloyQuery: savedQueries.malloySource,
      rowCount: sql<number | null>`null`,
      authorName: users.name,
      authorModel: savedQueries.authorModel,
    })
    .from(savedQueries)
    .leftJoin(users, eq(users.id, savedQueries.userId))
    .where(eq(savedQueries.datasetId, datasetId))
    .orderBy(desc(savedQueries.createdAt))
    .limit(200);

  const [hist, saved] = await Promise.all([fromHistory, fromSaved]);

  // Merge newest-first, deduping by slug so a promoted saved query and its
  // history twin count once (history wins — it carries the row count).
  const bySlug = new Map<string, DatasetQuestion>();
  const extras: DatasetQuestion[] = [];
  for (const r of hist) {
    if (r.slug) bySlug.set(r.slug, r);
    else extras.push(r);
  }
  for (const r of saved) {
    if (r.slug) { if (!bySlug.has(r.slug)) bySlug.set(r.slug, r); }
    else extras.push(r);
  }
  return [...bySlug.values(), ...extras]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 100);
}
