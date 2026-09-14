// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { eq, desc, and, ne, inArray } from "drizzle-orm";
import { db, datasets, malloyModels, malloyModelFiles, users } from "@/db";
import { DEVCONTAINER_PATH } from "@/lib/github-source-link";
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
      githubBranch: datasets.githubBranch,
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
    githubBranch: string | null;
    hasDevcontainer: boolean;
    githubConnected: boolean;
    ownerName?: string | null;
    sources: Array<{ source: string; description: string | null }>;
  }> = [];

  // Names are unique only among READY datasets — datasets_name_ready_unique is
  // partial — while this list includes everything not-failed. A creation stuck
  // in `modeling` can therefore share a name with the live dataset, and since
  // the name is now the key every caller joins and renders on, two rows with one
  // name merge a card, duplicate a React key, and hide one of them. Keep the
  // ready one; a half-built namesake is not what anyone means by that name.
  const byName = new Map<string, (typeof dsList)[number]>();
  for (const ds of dsList) {
    const held = byName.get(ds.name);
    if (!held || (held.status !== "ready" && ds.status === "ready")) byName.set(ds.name, ds);
  }

  // Model id → the index into `result` of the row it produced, so the dev
  // container lookup below is ONE query for the whole page rather than a second
  // per-dataset round trip on top of the one this loop already makes.
  const rowForModel = new Map<string, number>();

  for (const ds of byName.values()) {
    const [latestModel] = await db
      .select({
        id: malloyModels.id,
        sources: malloyModels.sources,
        gitRepo: malloyModels.gitRepo,
        gitBranch: malloyModels.gitBranch,
      })
      .from(malloyModels)
      .where(eq(malloyModels.datasetId, ds.id))
      .orderBy(desc(malloyModels.createdAt))
      .limit(1);

    const declared = normalizeSources(latestModel?.sources);
    if (latestModel) rowForModel.set(latestModel.id, result.length);
    result.push({
      dataset: ds.name,
      status: ds.status,
      isPublic: ds.isPublic,
      // "owner/repo" the model came from: the dataset's configured GitHub repo,
      // or the git remote recorded by a CLI publish.
      githubRepo: ds.githubRepo ?? latestModel?.gitRepo ?? null,
      // The branch that repo was taken from, paired with it: a dataset pinned to
      // a non-default branch must not hand out links to the default one. Same
      // precedence as the repo above, so the two always describe one tree.
      githubBranch: ds.githubBranch ?? latestModel?.gitBranch ?? null,
      // Filled in below — false until the file lookup says otherwise, so a
      // dataset with no model at all reads as "no codespace", which it is.
      hasDevcontainer: false,
      // How this dataset takes a new version, which is the last step of any
      // advice about changing its repo: a configured github_repo is refreshed
      // from the dataset's config page, everything else is `malloyyo publish`.
      githubConnected: ds.githubRepo !== null,
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

  // Whether each model carries the repo's dev container — see DEVCONTAINER_PATH.
  // Both publish paths store it as an ordinary model file precisely so this is a
  // local row lookup instead of a GitHub call per dataset per page view.
  if (rowForModel.size > 0) {
    const withContainer = await db
      .select({ modelId: malloyModelFiles.modelId })
      .from(malloyModelFiles)
      .where(
        and(
          inArray(malloyModelFiles.modelId, [...rowForModel.keys()]),
          eq(malloyModelFiles.path, DEVCONTAINER_PATH),
        ),
      );
    for (const row of withContainer) {
      const i = rowForModel.get(row.modelId);
      if (i !== undefined) result[i].hasDevcontainer = true;
    }
  }

  return NextResponse.json(result);
}
