// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { eq, and, ne, or, inArray, sql, desc } from "drizzle-orm";
import { db, datasets, savedQueries, favorites, users } from "@/db";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { isAdmin } from "@/lib/admin";
import { env } from "@/lib/env";

export const runtime = "nodejs";

// Saved queries favorited by the CALLER or by an ADMIN — not everyone's
// favorites — scoped to datasets the caller can see (same visibility as
// /api/sources). One row per qualifying saved query with its total favorite
// count, most-favorited first. The front page groups these by (datasetId,
// source) and lists a few under each source.
export async function GET() {
  let me;
  try { me = await getSessionUser(); } catch (err) {
    if (err instanceof UnauthorizedError) me = null;
    else throw err;
  }

  const admin = me ? isAdmin(me) : false;
  const visible = admin
    ? ne(datasets.status, "failed")
    : and(eq(datasets.isPublic, true), ne(datasets.status, "failed"));

  // Whose favorites count: mine + every admin's (admin = is_admin column OR the
  // APP_ADMIN_EMAILS allow-list, which isn't stored on the row).
  const adminEmails = env.APP_ADMIN_EMAILS.map((e) => e.toLowerCase());
  const adminUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(or(eq(users.isAdmin, true), adminEmails.length ? inArray(sql`lower(${users.email})`, adminEmails) : sql`false`));
  const allowedFavoriters = [...new Set([...(me ? [me.id] : []), ...adminUsers.map((u) => u.id)])];
  if (allowedFavoriters.length === 0) return NextResponse.json([]);

  const favRows = await db
    .select({ savedQueryId: favorites.savedQueryId })
    .from(favorites)
    .where(inArray(favorites.userId, allowedFavoriters));
  const qualifyingIds = [...new Set(favRows.map((r) => r.savedQueryId))];
  if (qualifyingIds.length === 0) return NextResponse.json([]);

  const favCount = sql<number>`(SELECT count(*)::int FROM favorites f WHERE f.saved_query_id = ${savedQueries.id})`;

  const rows = await db
    .select({
      datasetId: savedQueries.datasetId,
      source: savedQueries.source,
      slug: savedQueries.slug,
      question: savedQueries.question,
      favoriteCount: favCount,
    })
    .from(savedQueries)
    .innerJoin(datasets, eq(datasets.id, savedQueries.datasetId))
    .where(and(visible, inArray(savedQueries.id, qualifyingIds)))
    .orderBy(desc(favCount), desc(savedQueries.createdAt))
    .limit(500);

  return NextResponse.json(rows);
}
