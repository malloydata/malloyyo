// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * `POST /api/repos/:id/fetch` `{ "branch": "…" }` — fetch a branch from GitHub
 * as a PREVIEW: compiled, stored, never published (src/lib/repo-previews.ts).
 * The repo page's Fetch control; Claude's is the `fetch_branch` MCP tool.
 * Admin only, like refreshing the repo: it compiles code nobody has reviewed.
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, repos } from "@/db";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { isAdmin } from "@/lib/admin";
import { fetchBranchPreview } from "@/lib/repo-preview-store";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let me;
  try {
    me = await getSessionUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "sign in required" }, { status: 401 });
    throw err;
  }
  if (!isAdmin(me)) return NextResponse.json({ error: "admin required" }, { status: 403 });

  const { id } = await ctx.params;
  const [repo] = await db
    .select()
    .from(repos)
    .where(UUID.test(id) ? eq(repos.id, id) : eq(repos.slug, id))
    .limit(1);
  if (!repo) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { branch?: unknown };
  const branch = typeof body.branch === "string" ? body.branch.trim() : "";
  if (!branch) return NextResponse.json({ error: "give a branch" }, { status: 400 });

  const out = await fetchBranchPreview(repo, branch, me.id);
  return NextResponse.json(out, { status: out.ok ? 200 : 400 });
}
