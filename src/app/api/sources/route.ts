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
      ownerEmail: users.email,
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

  const result: Array<{
    source: string;
    description: string | null;
    /** The DATASET's name. It was called `model` from this file's first commit,
        back when a dataset and "a Malloy model" were the same idea. They are not
        any more — `malloy_models` is a different table holding the versioned
        model rows for a dataset — so the old name pointed at the wrong thing. */
    dataset: string;
    datasetId: string;
    status: string;
    isPublic: boolean;
    githubRepo: string | null;
    ownerEmail?: string | null;
    ownerName?: string | null;
  }> = [];

  for (const ds of dsList) {
    const [latestModel] = await db
      .select({ sources: malloyModels.sources, gitRepo: malloyModels.gitRepo })
      .from(malloyModels)
      .where(eq(malloyModels.datasetId, ds.id))
      .orderBy(desc(malloyModels.createdAt))
      .limit(1);

    const sources = normalizeSources(latestModel?.sources);
    const base = {
      datasetId: ds.id,
      dataset: ds.name,
      status: ds.status,
      isPublic: ds.isPublic,
      // "owner/repo" the model came from: the dataset's configured GitHub repo,
      // or the git remote recorded by a CLI publish.
      githubRepo: ds.githubRepo ?? latestModel?.gitRepo ?? null,
      ownerEmail: admin ? ds.ownerEmail : undefined,
      ownerName: admin ? ds.ownerName : undefined,
    };

    if (sources.length === 0) {
      result.push({ source: ds.name, description: null, ...base });
    } else if (sources.length === 1) {
      result.push({ source: sources[0].name, description: sources[0].description, ...base });
    } else {
      for (const src of sources) {
        result.push({ source: src.name, description: src.description, ...base });
      }
    }
  }

  return NextResponse.json(result);
}
