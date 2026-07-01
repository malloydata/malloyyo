// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { db, favorites } from "@/db";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { promoteToSaved } from "@/lib/mcp-tools";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let user;
  try { user = await getSessionUser(); } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "sign in required" }, { status: 401 });
    throw err;
  }

  const body = await req.json() as { slug?: string };
  const { slug } = body;
  if (!slug) return NextResponse.json({ error: "slug required" }, { status: 400 });

  // Favoriting promotes the run (by slug) into a durable saved_query — so the
  // favorite survives history trimming — then toggles the favorite on it.
  const saved = await promoteToSaved(slug);
  if (!saved) return NextResponse.json({ error: "query not found" }, { status: 404 });

  const existing = await db
    .select({ savedQueryId: favorites.savedQueryId })
    .from(favorites)
    .where(and(eq(favorites.userId, user.id), eq(favorites.savedQueryId, saved.id)))
    .limit(1);

  if (existing.length > 0) {
    await db.delete(favorites).where(and(eq(favorites.userId, user.id), eq(favorites.savedQueryId, saved.id)));
    return NextResponse.json({ isFavorited: false });
  } else {
    await db.insert(favorites).values({ userId: user.id, savedQueryId: saved.id });
    return NextResponse.json({ isFavorited: true });
  }
}
