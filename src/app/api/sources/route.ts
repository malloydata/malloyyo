// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { NextResponse } from "next/server";
import { eq, desc, and, inArray, ne } from "drizzle-orm";
import { db, datasets, malloyModelFiles, malloyModels, repoRevisions, repos, users } from "@/db";
import { DEVCONTAINER_PATH } from "@/lib/github-source-link";
import { qualifiedName } from "@/lib/repos";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { isAdmin } from "@/lib/admin";
import { datasetVisibleWhere } from "@/lib/roles";

export const runtime = "nodejs";

export async function GET() {
  let me;
  try { me = await getSessionUser(); } catch (err) {
    if (err instanceof UnauthorizedError) me = null;
    else throw err;
  }

  const admin = me ? isAdmin(me) : false;

  // Signed in: everything your roles open — which is what makes a grant on
  // /admin/roles visible here rather than only over MCP. Same predicate the run
  // paths use, so this list and what you may actually query cannot drift.
  // Signed out: public datasets only. An admin still sees the whole catalogue,
  // MALLOYYO_ADMIN opens every dataset, so listing and reading now give the same
  // answer and this needs no special case of its own. It used to have one, under
  // a comment saying the predicate had no admin branch — it does now.
  const where = me
    ? datasetVisibleWhere(me.id, admin)
    : and(eq(datasets.isPublic, true), ne(datasets.status, "failed"));

  const dsList = await db
    .select({
      id: datasets.id,
      name: datasets.name,
      status: datasets.status,
      isPublic: datasets.isPublic,
      repoDir: datasets.repoDir,
      // The GitHub attachment is the REPO's, which is the whole point of the
      // rewrite: it used to be two nullable text columns on every dataset row,
      // editable one row at a time, and one repo in production had three rows
      // disagreeing about its credential.
      repoSlug: repos.slug,
      githubRepo: repos.githubRepo,
      githubBranch: repos.githubBranch,
      // Does the repo's LIVE revision carry a dev container? Recorded on the
      // revision at verify time, so this is a join rather than a GitHub call per
      // dataset per page view (which with GITHUB_TOKEN unset spent a 60/hour
      // budget on the home page).
      hasDevcontainer: repoRevisions.hasDevcontainer,
      /** Null when no revision is live — see `needsUpdate` below. */
      liveRevisionId: repoRevisions.id,
      ownerName: users.name,
    })
    .from(datasets)
    .leftJoin(users, eq(datasets.userId, users.id))
    .leftJoin(repos, eq(datasets.repoId, repos.id))
    .leftJoin(
      repoRevisions,
      and(eq(repoRevisions.repoId, repos.id), eq(repoRevisions.active, true)),
    )
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
    qualified: string;
    repo: string | null;
    githubRepo: string | null;
    githubBranch: string | null;
    hasDevcontainer: boolean;
    githubConnected: boolean;
    /**
     * Still served the old way: no live revision behind it.
     *
     * True for a dataset whose repo has never been refetched since the upgrade,
     * and for one no repo publishes at all. Both are "the content lives in
     * `malloy_models` rows rather than in a verified revision", which is what an
     * admin needs to see and act on — by refreshing the repo, or for a dataset
     * with no GitHub behind it, by republishing it into one.
     */
    needsUpdate: boolean;
    ownerName?: string | null;
    sources: Array<{ source: string; description: string | null }>;
  }> = [];

  // DE-DUPED BY THE QUALIFIED NAME, not the bare one.
  //
  // Names are unique only among READY datasets — the index is partial — while
  // this list includes everything not-failed. A creation stuck in `modeling` can
  // therefore share a name with the live dataset, and since the name is the key
  // every caller joins and renders on, two rows with one name merge a card,
  // duplicate a React key, and hide one. Keep the ready one; a half-built
  // namesake is not what anyone means by that name.
  //
  // But the key has to be `<repo>:<name>`, because two repos may now each
  // publish a `sales` and that is the entire point of the rewrite. Keying on the
  // bare name here would have dropped one of them from the catalogue and the
  // home page — the collision quietly re-introduced one layer up from the schema
  // that was changed to allow it.
  const byName = new Map<string, (typeof dsList)[number]>();
  for (const ds of dsList) {
    const key = qualifiedName(ds.repoSlug, ds.name);
    const held = byName.get(key);
    if (!held || (held.status !== "ready" && ds.status === "ready")) byName.set(key, ds);
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
      // `active`, not `order by created_at desc limit 1`: the model a dataset
      // serves is stated by the activation, and two versions written in the same
      // millisecond tie under that ordering.
      .where(and(eq(malloyModels.datasetId, ds.id), eq(malloyModels.active, true)))
      .limit(1);

    const declared = normalizeSources(latestModel?.sources);
    if (latestModel) rowForModel.set(latestModel.id, result.length);
    result.push({
      dataset: ds.name,
      // The public identity: `<repo>:<name>`, or the bare name for a dataset no
      // repo publishes. Additive - `dataset` keeps meaning what it meant.
      qualified: qualifiedName(ds.repoSlug, ds.name),
      repo: ds.repoSlug,
      needsUpdate: ds.liveRevisionId === null,
      status: ds.status,
      isPublic: ds.isPublic,
      // "owner/repo" the model came from: the dataset's configured GitHub repo,
      // or the git remote recorded by a CLI publish.
      githubRepo: ds.githubRepo ?? latestModel?.gitRepo ?? null,
      // The branch that repo was taken from, paired with it: a dataset pinned to
      // a non-default branch must not hand out links to the default one. Same
      // precedence as the repo above, so the two always describe one tree.
      githubBranch: ds.githubBranch ?? latestModel?.gitBranch ?? null,
      // From the repo's live revision when a repo publishes it. For a dataset
      // no repo publishes — a Claude-authored one, or `--dataset x`, which
      // still stores its files as rows — it is filled in below from those
      // rows. Dropping that fallback took the "open in codespace" button away
      // from every single-dataset CLI publish, which is a capability loss
      // disguised as a cleanup.
      hasDevcontainer: ds.hasDevcontainer ?? false,
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

  // The dev container for a model with no revision: still an ordinary stored
  // file row, because `--dataset x` stores its files that way. ONE query for
  // the whole page, as before.
  const rowless = [...rowForModel.entries()]
    .filter(([, i]) => !result[i].hasDevcontainer)
    .map(([modelId]) => modelId);
  if (rowless.length > 0) {
    const withContainer = await db
      .select({ modelId: malloyModelFiles.modelId })
      .from(malloyModelFiles)
      .where(
        and(inArray(malloyModelFiles.modelId, rowless), eq(malloyModelFiles.path, DEVCONTAINER_PATH)),
      );
    for (const row of withContainer) {
      const i = rowForModel.get(row.modelId);
      if (i !== undefined) result[i].hasDevcontainer = true;
    }
  }

  return NextResponse.json(result);
}
