// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { runDashboard } from "@/lib/dashboards/engine";

export const runtime = "nodejs";

// The bridge: a dashboard iframe (via the trusted parent page) asks to run a
// query with the current given values. `query` names a model-published query
// (default: the stored manifest's); `malloy` runs restricted Malloy text —
// core's restricted mode is the gate (suggestion queries, ad-hoc panels).
export async function POST(req: Request) {
  let user;
  try {
    user = await getSessionUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ ok: false, error: "sign in required" }, { status: 401 });
    throw err;
  }
  let body: {
    datasetId?: string;
    name?: string;
    query?: string;
    malloy?: string;
    givens?: Record<string, unknown>;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  const { datasetId, name, query, malloy, givens } = body;
  if (!datasetId || !name) {
    return NextResponse.json({ ok: false, error: "datasetId and name are required" }, { status: 400 });
  }
  const result = await runDashboard(user.id, datasetId, name, { query, malloy }, givens ?? {});
  return NextResponse.json(result);
}
