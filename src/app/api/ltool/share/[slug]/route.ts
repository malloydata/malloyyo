// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { loadSharedQuery, sharedQueryListContext } from "@/lib/mcp-tools";

export const runtime = "nodejs";

// Resolve a share slug into { instance, source, question, malloy } for the
// ltool deep-link page, plus the viewer's list context (favorite/author flags)
// so the page can open on a tab+scope that actually contains the query.
// Requires sign-in; actually running the query is gated separately by /api/run
// (which enforces source visibility).
export async function GET(
  _req: Request,
  ctx: RouteContext<"/api/ltool/share/[slug]">,
) {
  let user;
  try { user = await getSessionUser(); } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "sign in required" }, { status: 401 });
    throw err;
  }

  const { slug } = await ctx.params;
  const res = await loadSharedQuery(slug);
  if (!res.ok) {
    return NextResponse.json({ error: res.error, wrongInstance: res.wrongInstance }, { status: 404 });
  }
  const ctxFlags = await sharedQueryListContext(slug, user.id);
  return NextResponse.json({
    instance: res.instance,
    source: res.source,
    question: res.question,
    malloy: res.malloy,
    favoritedByMe: ctxFlags?.favoritedByMe ?? false,
    favoriteCount: ctxFlags?.favoriteCount ?? 0,
    authoredByMe: ctxFlags?.authoredByMe ?? false,
  });
}
