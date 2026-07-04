// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { runDashboard } from "@/lib/dashboards";

export const runtime = "nodejs";

// The bridge: a dashboard iframe (via the trusted parent page) asks to run its
// declared query with the current given values. The query is fixed by the stored
// manifest server-side; the client only supplies givens.
export async function POST(req: Request) {
  let user;
  try {
    user = await getSessionUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ ok: false, error: "sign in required" }, { status: 401 });
    throw err;
  }
  let body: { datasetId?: string; name?: string; givens?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const { datasetId, name, givens } = body;
  if (!datasetId || !name) {
    return NextResponse.json({ ok: false, error: "datasetId and name are required" }, { status: 400 });
  }
  const result = await runDashboard(user.id, datasetId, name, givens ?? {});
  return NextResponse.json(result);
}
