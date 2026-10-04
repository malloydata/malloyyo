// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { db, datasets, repos } from "@/db";
import { qualifiedName } from "@/lib/repos";
import { datasetTitle } from "@malloyyo/mcp-engine";
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
    const { datasets: treeDatasets, byDataset } = await allDashboardsByDataset(user.id);
    return NextResponse.json(
      treeDatasets
        .map((ds) => ({
          dataset: ds.name,
          // What links address it by. Bare names are not unique across repos, so
          // a tree built from them sent two datasets' dashboards to one of them.
          // Joined by the query above rather than resolved here: a second pass
          // over the ids it just returned is a round trip, and this endpoint's
          // cost is round trips.
          qualified: ds.qualified,
          title: datasetTitle(ds.name, ds.title),
          ...(ds.description ? { description: ds.description } : {}),
          dashboards: (byDataset.get(ds.id) ?? []).map((d) => wire(d, user.id)),
        }))
        .sort((a, b) => a.dataset.localeCompare(b.dataset)),
    );
  }
  const datasetId = params.get("datasetId");
  const list = datasetId ? await listDashboardsAndDrafts(user.id, datasetId) : await listAllDashboards(user.id);

  // The QUALIFIED name alongside the bare one.
  //
  // A dataset name is unique inside its repo and no further, so the front page —
  // which joins these by name — poured two repos' dashboards into one bucket and
  // rendered every one of them twice. Resolved from the dataset id the summaries
  // already carry, so `meta.ts` and its callers are untouched.
  const ids = [...new Set(list.map((d) => d.datasetId))];
  const owners = ids.length
    ? await db
        .select({ id: datasets.id, name: datasets.name, repoSlug: repos.slug })
        .from(datasets)
        .leftJoin(repos, eq(datasets.repoId, repos.id))
        .where(inArray(datasets.id, ids))
    : [];
  const qualifiedById = new Map(
    owners.map((o) => [o.id, o.repoSlug ? qualifiedName(o.repoSlug, o.name) : o.name]),
  );

  return NextResponse.json(
    list.map((d) => ({
      dataset: d.datasetName,
      qualified: qualifiedById.get(d.datasetId) ?? d.datasetName,
      ...wire(d, user.id),
    })),
  );
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
