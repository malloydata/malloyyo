// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import type { DashboardSummary } from "@/lib/dashboards";
import { allDashboardsByDataset, listAllDashboards, listDashboardsAndDrafts } from "@/lib/dashboards";

export const runtime = "nodejs";

// GET /api/dashboards            → all visible dashboards, flat (home page)
// GET /api/dashboards?datasetId= → dashboards on one dataset
// GET /api/dashboards?tree=1     → grouped by dataset, INCLUDING datasets with
//                                  none (the nav tree lists those too, so you
//                                  can reach a dataset nobody has built on)
export async function GET(req: Request) {
  let user;
  try {
    user = await getSessionUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "sign in required" }, { status: 401 });
    throw err;
  }
  const params = new URL(req.url).searchParams;
  if (params.get("tree")) {
    const { datasets, byDataset } = await allDashboardsByDataset(user.id);
    return NextResponse.json(
      datasets
        .map((ds) => ({
          dataset: ds.name,
          dashboards: (byDataset.get(ds.id) ?? []).map((d) => wire(d, user.id)),
        }))
        .sort((a, b) => a.dataset.localeCompare(b.dataset)),
    );
  }
  const datasetId = params.get("datasetId");
  const list = datasetId ? await listDashboardsAndDrafts(user.id, datasetId) : await listAllDashboards(user.id);
  // The summaries carry the dataset id for server-side callers; the wire form
  // identifies a dataset by NAME, which is what links are built from and what
  // the front page joins on.
  return NextResponse.json(list.map((d) => ({ dataset: d.datasetName, ...wire(d, user.id) })));
}

/** A summary as the browser sees it. `mine` rather than the author id: a
    listing sorts a reader's own first, and no client needs other people's ids. */
function wire(
  { name, title, description, isDraft, author, authorId }: DashboardSummary,
  userId: string,
) {
  return {
    name,
    title,
    ...(description ? { description } : {}),
    ...(isDraft ? { isDraft: true, author, mine: authorId === userId } : {}),
  };
}
