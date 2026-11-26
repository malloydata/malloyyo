// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { db, favorites } from "@/db";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { loadSharedQuery, maySeeSharedQuery, promoteToSaved } from "@/lib/mcp-tools";
import { isAdmin } from "@/lib/admin";
import { rolesOf } from "@/lib/roles";
import { captureTelemetry } from "@/lib/telemetry";

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

  // Only a query this person may see. This used to take any slug: it copied
  // the author's question, Malloy and SQL out of disposable history into a
  // durable saved query, and answered 200 or 404 by whether the slug existed —
  // for someone the share link itself would have told "not found".
  const shared = await loadSharedQuery(slug);
  const viewer = { id: user.id, roles: rolesOf(user), admin: isAdmin(user) };
  if (!shared.ok || !(await maySeeSharedQuery(viewer, slug, shared.datasetId))) {
    return NextResponse.json({ error: "query not found" }, { status: 404 });
  }

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
    void captureTelemetry({ event: "query favorite changed", properties: { favorited: false } }, user.id);
    return NextResponse.json({ isFavorited: false });
  } else {
    await db.insert(favorites).values({ userId: user.id, savedQueryId: saved.id });
    void captureTelemetry({ event: "query favorite changed", properties: { favorited: true } }, user.id);
    return NextResponse.json({ isFavorited: true });
  }
}
