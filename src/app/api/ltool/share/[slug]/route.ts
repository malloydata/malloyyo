// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { isAdmin } from "@/lib/admin";
import { canReadDataset, datasetNameById, loadSharedQuery, sharedQueryListContext } from "@/lib/mcp-tools";
import { db, datasets } from "@/db";
import { eq } from "drizzle-orm";

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
  // A slug names a dataset, and this used to answer for any of them. Running the
  // query was always gated (/api/run resolves through visibleDatasetWhere), but
  // the QUESTION and the MALLOY came back regardless — and those name a private
  // model's fields and filters. Gated now on the same rule as the history list,
  // or the answer would be hidden in one place and a link away in another.
  if (res.datasetId) {
    const [ds] = await db
      .select({ isPublic: datasets.isPublic, userId: datasets.userId })
      .from(datasets)
      .where(eq(datasets.id, res.datasetId));
    if (ds && !canReadDataset(ds, user.id, isAdmin(user))) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
  }

  const ctxFlags = await sharedQueryListContext(slug, user.id);
  return NextResponse.json({
    instance: res.instance,
    source: res.source,
    // By name: the client uses this to build links and to re-run, and both take
    // a ref. The stored id stays on the server.
    dataset: res.datasetId ? await datasetNameById(res.datasetId) : null,
    question: res.question,
    malloy: res.malloy,
    favoritedByMe: ctxFlags?.favoritedByMe ?? false,
    favoriteCount: ctxFlags?.favoriteCount ?? 0,
    authoredByMe: ctxFlags?.authoredByMe ?? false,
  });
}
