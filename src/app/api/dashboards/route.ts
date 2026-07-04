// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { listDashboards, listAllDashboards } from "@/lib/dashboards";

export const runtime = "nodejs";

// GET /api/dashboards            → all visible dashboards (home page)
// GET /api/dashboards?datasetId= → dashboards on one dataset
export async function GET(req: Request) {
  let user;
  try {
    user = await getSessionUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "sign in required" }, { status: 401 });
    throw err;
  }
  const datasetId = new URL(req.url).searchParams.get("datasetId");
  const list = datasetId ? await listDashboards(user.id, datasetId) : await listAllDashboards(user.id);
  return NextResponse.json(list);
}
