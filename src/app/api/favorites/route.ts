// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { db, favorites } from "@/db";
import { getSessionUser, UnauthorizedError } from "@/lib/user";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let user;
  try { user = await getSessionUser(); } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "sign in required" }, { status: 401 });
    throw err;
  }

  const body = await req.json() as { inquiryId?: string };
  const { inquiryId } = body;
  if (!inquiryId) return NextResponse.json({ error: "inquiryId required" }, { status: 400 });

  const existing = await db
    .select({ inquiryId: favorites.inquiryId })
    .from(favorites)
    .where(and(eq(favorites.userId, user.id), eq(favorites.inquiryId, inquiryId)))
    .limit(1);

  if (existing.length > 0) {
    await db.delete(favorites).where(and(eq(favorites.userId, user.id), eq(favorites.inquiryId, inquiryId)));
    return NextResponse.json({ isFavorited: false });
  } else {
    await db.insert(favorites).values({ userId: user.id, inquiryId });
    return NextResponse.json({ isFavorited: true });
  }
}
