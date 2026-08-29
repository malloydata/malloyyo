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
  // The summaries carry the dataset id for server-side callers; the wire form
  // identifies a dataset by NAME, which is what links are built from and what
  // the front page joins on.
  return NextResponse.json(
    list.map(({ datasetName, name, title }) => ({ dataset: datasetName, name, title })),
  );
}
