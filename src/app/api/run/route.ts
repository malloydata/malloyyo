// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { runQueryForWeb, saveWebQuery, resolveLtoolAuthor } from "@/lib/mcp-tools";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let user;
  try { user = await getSessionUser(); } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "sign in required" }, { status: 401 });
    throw err;
  }

  let body: { source: string; malloy: string; maxRows?: number; save?: boolean; title?: string; datasetId?: string | null; baseSlug?: string | null; question?: string | null };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const { source, malloy, maxRows = 1000, save = false, title, datasetId, baseSlug, question } = body;
  if (!source || !malloy) {
    return NextResponse.json({ error: "source and malloy are required" }, { status: 400 });
  }

  // Runs from ltool are browser runs: user_agent is the browser, and the author
  // is 'human' unless this is an unmodified replay of a loaded query (baseSlug),
  // in which case the original author is inherited — decided server-side.
  const userAgent = req.headers.get("user-agent");
  const authorModel = await resolveLtoolAuthor(baseSlug, malloy);
  const opts = { userAgent, authorModel, question: question ?? title ?? null };

  // `save` persists the run as a durable saved_query with a fresh slug (used
  // when the user edits a loaded query). Otherwise it's a transient run (still
  // recorded to history). `datasetId`, when present (an ltool replay), names the
  // exact model — unambiguous.
  if (save) {
    const cleanTitle = (title?.trim() || malloy.trim().slice(0, 80)).slice(0, 200);
    const result = await saveWebQuery(user.id, source, malloy, cleanTitle, maxRows, datasetId, opts);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json(result);
  }

  const result = await runQueryForWeb(user.id, source, malloy, maxRows, datasetId, opts);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json(result);
}
