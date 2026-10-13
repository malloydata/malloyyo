// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { UnauthorizedError } from "@/lib/user";
import { getDashboardViewer, isScreenshotRequest } from "@/lib/dashboards/viewer";
import { runDashboard } from "@/lib/dashboards/engine";
import { captureTelemetry } from "@/lib/telemetry";

export const runtime = "nodejs";

// The bridge: a dashboard iframe (via the trusted parent page) asks to run a
// query with the current given values. `query` names a model-published query
// (default: the stored manifest's); `malloy` runs restricted Malloy text —
// core's restricted mode is the gate (suggestion queries, ad-hoc panels).
export async function POST(req: Request) {
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
  // The session, or a screenshot token naming exactly this dashboard (viewer.ts).
  let user;
  try {
    user = await getDashboardViewer(datasetId, name);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ ok: false, error: "sign in required" }, { status: 401 });
    throw err;
  }
  const startedAt = Date.now();
  const result = await runDashboard(user, datasetId, name, { query, malloy }, givens ?? {});
  // A screenshot's queries are not a person using the dashboard; the
  // screenshot_dashboard call that caused them is recorded as itself.
  if (await isScreenshotRequest()) return NextResponse.json(result);
  void captureTelemetry(
    {
      event: "query ran",
      properties: {
        entrypoint: "dashboard",
        outcome: result.ok ? "success" : "error",
        duration_ms: Date.now() - startedAt,
        author_kind: "human",
        client_family: "browser",
      },
    },
    user.id,
  );
  return NextResponse.json(result);
}
