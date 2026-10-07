// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { askEnabled } from "@/lib/ask";
import { writeFilter } from "@/lib/dashboards/write-filter";

export const runtime = "nodejs";

// The explorer's "✨ write it": a description typed into a filter box → a
// Malloy filter expression (or a reason there isn't one). Signed-in viewers
// only; enabled exactly when Ask is. No model data leaves except the few
// sample values the frame already fetched for typeahead.
export async function POST(req: Request) {
  try {
    await getSessionUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ ok: false, error: "sign in required" }, { status: 401 });
    throw err;
  }
  if (!askEnabled()) return NextResponse.json({ ok: false, error: "filter help is not enabled on this instance" }, { status: 404 });
  let body: { field?: string; type?: string; description?: string; values?: unknown; source?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const out = await writeFilter({
    field: String(body.field ?? ""),
    type: String(body.type ?? "string"),
    description: String(body.description ?? ""),
    values: Array.isArray(body.values) ? body.values.slice(0, 60).map(String) : undefined,
    source: body.source ? String(body.source) : undefined,
  });
  return NextResponse.json(out);
}
