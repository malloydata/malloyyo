// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { eq, desc, and, ne } from "drizzle-orm";
import { db, datasets, malloyModels, users } from "@/db";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { isAdmin } from "@/lib/admin";

export const runtime = "nodejs";

export async function GET() {
  let me;
  try { me = await getSessionUser(); } catch (err) {
    if (err instanceof UnauthorizedError) me = null;
    else throw err;
  }

  const admin = me ? isAdmin(me) : false;

  const where = admin
    ? ne(datasets.status, "failed")
    : and(eq(datasets.isPublic, true), ne(datasets.status, "failed"));

  const dsList = await db
    .select({
      id: datasets.id,
      name: datasets.name,
      status: datasets.status,
      isPublic: datasets.isPublic,
      githubRepo: datasets.githubRepo,
      ownerName: users.name,
    })
    .from(datasets)
    .leftJoin(users, eq(datasets.userId, users.id))
    .where(where)
    .orderBy(desc(datasets.createdAt))
    .limit(200);

  type SourceEntry = string | { name: string; description?: string | null };
  function normalizeSources(raw: unknown): Array<{ name: string; description: string | null }> {
    if (!Array.isArray(raw)) return [];
    return (raw as SourceEntry[]).map((s) =>
      typeof s === "string" ? { name: s, description: null } : { name: String(s.name), description: s.description ?? null }
    );
  }

  // DATASET-FIRST: each dataset once, with the sources it offers.
  //
  // This used to be a flat list of sources with the dataset's five fields copied
  // onto every row — 44 rows for eight datasets here — and both callers began by
  // regrouping it back into exactly this shape. The endpoint returned the
  // inverse of what anyone wanted, and the duplication was the only reason a
  // dataset id had to ride along as a join key.
  //
  // No dataset id: nothing outside the server needs one. Links address a dataset
  // by NAME, which is unique per server (see findByDatasetRef), so the name is
  // also the key the front page joins dashboards and questions on.
  const result: Array<{
    dataset: string;
    status: string;
    isPublic: boolean;
    githubRepo: string | null;
    ownerName?: string | null;
    sources: Array<{ source: string; description: string | null }>;
  }> = [];

  for (const ds of dsList) {
    const [latestModel] = await db
      .select({ sources: malloyModels.sources, gitRepo: malloyModels.gitRepo })
      .from(malloyModels)
      .where(eq(malloyModels.datasetId, ds.id))
      .orderBy(desc(malloyModels.createdAt))
      .limit(1);

    const declared = normalizeSources(latestModel?.sources);
    result.push({
      dataset: ds.name,
      status: ds.status,
      isPublic: ds.isPublic,
      // "owner/repo" the model came from: the dataset's configured GitHub repo,
      // or the git remote recorded by a CLI publish.
      githubRepo: ds.githubRepo ?? latestModel?.gitRepo ?? null,
      ...(admin ? { ownerName: ds.ownerName } : {}),
      // A model that declares nothing still gets one row, named for the dataset,
      // so it appears in the catalogue at all rather than silently vanishing.
      // Long-standing behaviour, kept.
      sources:
        declared.length === 0
          ? [{ source: ds.name, description: null }]
          : declared.map((src) => ({ source: src.name, description: src.description })),
    });
  }

  return NextResponse.json(result);
}
