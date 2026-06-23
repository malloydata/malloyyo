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
    model: string;
    datasetId: string;
    status: string;
    isPublic: boolean;
    ownerEmail?: string | null;
    ownerName?: string | null;
  }> = [];

  for (const ds of dsList) {
    const [latestModel] = await db
      .select({ sources: malloyModels.sources })
      .from(malloyModels)
      .where(eq(malloyModels.datasetId, ds.id))
      .orderBy(desc(malloyModels.createdAt))
      .limit(1);

    const sources = normalizeSources(latestModel?.sources);
    const base = {
      datasetId: ds.id,
      model: ds.name,
      status: ds.status,
      isPublic: ds.isPublic,
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
