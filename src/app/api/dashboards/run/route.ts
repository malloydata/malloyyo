// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { getSession, UnauthorizedError } from "@/lib/user";
import { logger } from "@/lib/logger";
import { runDashboard } from "@/lib/dashboards/engine";
import { captureTelemetry } from "@/lib/telemetry";

export const runtime = "nodejs";

// The bridge: a dashboard iframe (via the trusted parent page) asks to run a
// query with the current given values. `query` names a model-published query
// (default: the stored manifest's); `malloy` runs restricted Malloy text —
// core's restricted mode is the gate (suggestion queries, ad-hoc panels).
export async function POST(req: Request) {
  let user;
  let viewedBy;
  try {
    ({ user, viewedBy } = await getSession());
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
  const startedAt = Date.now();
  const result = await runDashboard(user, datasetId, name, { query, malloy }, givens ?? {});
  // An admin IMPERSONATING this user (src/lib/view-as.ts). The query ran as
  // them, which is the point; what must not happen is that it is then counted
  // as something they did. This route is one of the two a write-refusing
  // impersonation lets through, and the rule for both is that nothing is left
  // behind as the person — a usage event keyed to them is exactly that. What
  // is written down is that the admin did it, as /api/run does.
  if (viewedBy) {
    logger.info("view-as dashboard query", { actorId: viewedBy.id, targetId: user.id, datasetId, name });
    return NextResponse.json(result);
  }
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
