// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, savedQueries, history } from "@/db";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { isAdmin } from "@/lib/admin";

export const runtime = "nodejs";

// Rename a saved query by slug. Updates the durable saved_queries title (what
// share resolution shows) AND the history run row with that slug (what the
// /ltool history list shows). You may only rename your OWN queries — unless you
// are an admin, who may rename anyone's.
export async function POST(req: Request) {
  let user;
  try { user = await getSessionUser(); } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "sign in required" }, { status: 401 });
    throw err;
  }

  const body = await req.json() as { slug?: string; title?: string };
  const slug = body.slug;
  const title = body.title?.trim();
  if (!slug || !title) return NextResponse.json({ error: "slug and title required" }, { status: 400 });
  const clean = title.slice(0, 200);

  const admin = isAdmin(user);
  const sqWhere = admin ? eq(savedQueries.slug, slug) : and(eq(savedQueries.slug, slug), eq(savedQueries.userId, user.id));
  const histWhere = admin ? eq(history.slug, slug) : and(eq(history.slug, slug), eq(history.userId, user.id));

  const updated = await db.update(savedQueries).set({ question: clean }).where(sqWhere).returning({ id: savedQueries.id });
  if (updated.length === 0) return NextResponse.json({ error: "not found or not yours" }, { status: 403 });
  await db.update(history).set({ question: clean }).where(histWhere);

  return NextResponse.json({ ok: true, title: clean });
}
