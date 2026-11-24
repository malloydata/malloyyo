// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * `POST /api/datasets/:id/repo` — move a repo-less dataset into a repo.
 * Body: `{ repo: "owner/name", dir: "" | "datasets/<name>" }`. Admin, browser
 * session. The work and its rules are in src/lib/repo-attach.ts.
 */

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { attachDatasetToRepo } from "@/lib/repo-attach";
import { UnauthorizedError } from "@/lib/user";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let me;
  try {
    me = await requireAdmin();
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: err.message }, { status: 403 });
    throw err;
  }
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { repo?: unknown; dir?: unknown } | null;
  if (typeof body?.repo !== "string" || typeof body?.dir !== "string") {
    return NextResponse.json({ error: "send { repo, dir }" }, { status: 400 });
  }
  const r = await attachDatasetToRepo({ dataset: id, repo: body.repo, dir: body.dir, userId: me.id });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, repo: r.repo.slug, dir: r.dir, createdRepo: r.createdRepo });
}
