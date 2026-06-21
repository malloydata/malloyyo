// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { runQueryForWeb, saveWebQuery } from "@/lib/mcp-tools";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let user;
  try { user = await getSessionUser(); } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "sign in required" }, { status: 401 });
    throw err;
  }

  let body: { source: string; malloy: string; maxRows?: number; save?: boolean; title?: string; datasetId?: string | null };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const { source, malloy, maxRows = 1000, save = false, title, datasetId } = body;
  if (!source || !malloy) {
    return NextResponse.json({ error: "source and malloy are required" }, { status: 400 });
  }

  // `save` persists the run as a new history entry with a fresh slug (used when
  // the user edits a loaded query). Otherwise it's a transient run. `datasetId`,
  // when present (an ltool replay), names the exact model — unambiguous.
  if (save) {
    const cleanTitle = (title?.trim() || malloy.trim().slice(0, 80)).slice(0, 200);
    const result = await saveWebQuery(user.id, source, malloy, cleanTitle, maxRows, datasetId);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json(result);
  }

  const result = await runQueryForWeb(user.id, source, malloy, maxRows, datasetId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json(result);
}
