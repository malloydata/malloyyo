// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { eq, desc, and, isNull, isNotNull, inArray, sql } from "drizzle-orm";
import { db, history, savedQueries, users } from "@/db";
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
