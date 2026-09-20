// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { requireBearer } from "@/lib/bearer-auth";
import { getDraftFiles, recordPromotion } from "@/lib/dashboards/draft";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; slug: string }> };

/**
 * GET /api/datasets/:ref/drafts/:slug — a draft's files, so `malloyyo draft
 * promote` can write them into a model checkout. Returns the component, the
 * .malloy (when the draft has one), and the literal Malloy the component runs
 * inline — the queries promotion has to lift into the .malloy.
 */
export async function GET(req: Request, ctx: Ctx) {
  const auth = await requireBearer(req, { scope: "mcp" });
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const { id, slug } = await ctx.params;
  const draft = await getDraftFiles(auth.user.id, id, slug);
  if (!draft) return NextResponse.json({ ok: false, error: `no draft '${slug}' in '${id}'` }, { status: 404 });
  return NextResponse.json({ ok: true, draft });
}

/**
 * POST /api/datasets/:ref/drafts/:slug — record that this draft was promoted
 * into a repo as `name`, with a hash of what was written. Body: { name, hash }.
 *
 * Records, never deletes: the draft stays the only usable copy until the model
 * version carrying it is live, and its URL keeps working afterwards.
 */
export async function POST(req: Request, ctx: Ctx) {
  const auth = await requireBearer(req, { scope: "mcp" });
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  let body: { name?: unknown; hash?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const name = String(body.name ?? "");
  const hash = String(body.hash ?? "");
  if (!name || !hash) return NextResponse.json({ ok: false, error: "name and hash are required" }, { status: 400 });
  const { id, slug } = await ctx.params;
  const ok = await recordPromotion(auth.user.id, id, slug, { name, hash });
  return ok
    ? NextResponse.json({ ok: true, promotedAs: name })
    : NextResponse.json({ ok: false, error: `no draft '${slug}' in '${id}'` }, { status: 404 });
}
