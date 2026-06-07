// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { eq, desc, and, isNull, sql } from "drizzle-orm";
import { db, inquiries, toolCalls, users } from "@/db";
import { getSessionUser, UnauthorizedError } from "@/lib/user";

export const runtime = "nodejs";

// Correlated EXISTS checking if the current user has favorited this inquiry.
// Uses toolCalls.inquiryId as a column reference (drizzle resolves to tool_calls.inquiry_id).
function favExists(userId: string) {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM favorites
    WHERE favorites.inquiry_id = ${toolCalls.inquiryId}
    AND favorites.user_id = ${userId}::uuid
  )`;
}

// Any user (including the current one) has favorited this inquiry.
function anyFavExists() {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM favorites
    WHERE favorites.inquiry_id = ${toolCalls.inquiryId}
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

  const rows = await db
    .select({
      inquiryId: toolCalls.inquiryId,
      slug: inquiries.slug,
      question: inquiries.question,
      createdAt: toolCalls.createdAt,
      source: toolCalls.source,
      datasetId: toolCalls.datasetId,
      malloyQuery: toolCalls.malloyInput,
      rowCount: toolCalls.rowCount,
      durationMs: toolCalls.durationMs,
      toolSeq: toolCalls.sequence,
      authorName: users.name,
      isFavorited: favExists(user.id),
      favoriteCount: sql<number>`(SELECT count(*)::int FROM favorites WHERE favorites.inquiry_id = ${toolCalls.inquiryId})`,
    })
    .from(toolCalls)
    .leftJoin(inquiries, eq(inquiries.id, toolCalls.inquiryId))
    .leftJoin(users, eq(users.id, toolCalls.userId))
    .where(
      and(
        eq(toolCalls.toolName, "run_query"),
        isNull(toolCalls.error),
        // History view: scope filters the query author.
        view !== "favorites" && scope === "me" ? eq(toolCalls.userId, user.id) : undefined,
        // Favorites view: scope filters WHOSE favorites — mine vs anyone's —
        // regardless of who authored the query.
        view === "favorites" ? (scope === "me" ? favExists(user.id) : anyFavExists()) : undefined,
      )
    )
    .orderBy(desc(toolCalls.createdAt))
    .limit(500);

  // Keep the latest successful tool call per inquiry (dedup by inquiryId).
  const seen = new Set<string>();
  const history = rows
    .filter((row) => {
      const key = row.inquiryId ?? `tc-${row.source}-${row.createdAt}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 100);

  return NextResponse.json(history);
}
