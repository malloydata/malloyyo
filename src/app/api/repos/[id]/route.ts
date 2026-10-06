// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * `GET|PATCH /api/repos/:id` — the repo, and its settings.
 *
 * `:id` is the repo's slug or its uuid, the same way a dataset's route takes
 * either, so a link can be readable.
 *
 * These settings used to be edited on a DATASET's config page, which wrote them
 * to that one row. A repo with four datasets therefore offered four copies of
 * one set of settings, each independently editable, and one repo in production
 * ended up with three rows disagreeing about its credential. There is one row to
 * write now, and this is the only thing that writes it.
 */

import { NextResponse } from "next/server";
import { and, asc, count, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db, chats, datasets, draftDashboards, repos, repoRevisions, malloyModels, savedQueries } from "@/db";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { isAdmin } from "@/lib/admin";
import { parseGitHubRepo } from "@/lib/github";
import { qualifiedName } from "@/lib/repos";
import { datasetTitle, repoPath } from "@malloyyo/mcp-engine";
import { logger } from "@/lib/logger";
import { captureTelemetry } from "@/lib/telemetry";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function load(ref: string) {
  const [repo] = await db
    .select()
    .from(repos)
    .where(UUID.test(ref) ? eq(repos.id, ref) : eq(repos.slug, ref))
    .limit(1);
  return repo ?? null;
}

/**
 * What removing this repo would destroy, counted before anybody confirms it.
 *
 * `DELETE FROM repos` is one statement because the foreign keys cascade the
 * whole way down — datasets, their aliases, models, artifacts, model files,
 * saved queries and drafts, plus every revision. That is convenient and it is
 * also why the operation needs to show its work: "remove this repository"
 * sounds like it unlinks a GitHub coordinate, and it actually deletes other
 * people's saved queries.
 *
 * Chats are counted separately and NOT deleted. `chats.dataset` is a text name
 * with no foreign key, so nothing cascades to them; they would be left pointing
 * at a dataset that no longer exists. Deleting them anyway would throw away
 * users' own question history, which is more than was asked for, so they are
 * reported and left alone — see the note in the DELETE handler.
 *
 * That column holds BOTH spellings, which is why the count matches both. It is
 * filled from the `?dataset=` parameter on the link that opened the chat, and
 * those links were changed to carry the qualified `repo:dataset` — so rows
 * written before that change hold a bare name and rows written after hold a
 * qualified one. Matching bare names alone missed every recent chat; matching
 * them at all is also ambiguous across repos, since two repos may each publish
 * an `orders`, so the bare half of this count can over-report by including
 * another repo's chats. Both halves are kept because both are real historical
 * values, and the number is a warning rather than a deletion — but it is an
 * estimate, and the response says so.
 */
async function removalImpact(repoId: string, repoSlug: string, datasetNames: string[]) {
  const ids = (
    await db.select({ id: datasets.id }).from(datasets).where(eq(datasets.repoId, repoId))
  ).map((d) => d.id);

  const one = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;

  const [revisions, saved, drafts, orphanedChats] = await Promise.all([
    one(db.select({ n: count() }).from(repoRevisions).where(eq(repoRevisions.repoId, repoId))),
    ids.length
      ? one(db.select({ n: count() }).from(savedQueries).where(inArray(savedQueries.datasetId, ids)))
      : Promise.resolve(0),
    ids.length
      ? one(db.select({ n: count() }).from(draftDashboards).where(inArray(draftDashboards.datasetId, ids)))
      : Promise.resolve(0),
    datasetNames.length
      ? one(
          db
            .select({ n: count() })
            .from(chats)
            .where(
              inArray(chats.dataset, [
                ...datasetNames,
                ...datasetNames.map((n) => qualifiedName(repoSlug, n)),
              ]),
            ),
        )
      : Promise.resolve(0),
  ]);

  return { datasets: ids.length, revisions, savedQueries: saved, drafts, orphanedChats };
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let me;
  try {
    me = await getSessionUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "sign in required" }, { status: 401 });
    throw err;
  }
  // Admin-only, like the dataset config page this replaces: a repo's settings
  // name the GitHub it will be compiled from, and compiling runs SQL against
  // this server's own connections.
  if (!isAdmin(me)) return NextResponse.json({ error: "admin required" }, { status: 403 });

  const { id } = await ctx.params;
  const repo = await load(id);
  if (!repo) return NextResponse.json({ error: "not found" }, { status: 404 });

  const [live] = await db
    .select()
    .from(repoRevisions)
    .where(and(eq(repoRevisions.repoId, repo.id), eq(repoRevisions.active, true)))
    .limit(1);

  const history = await db
    .select({
      id: repoRevisions.id,
      revision: repoRevisions.revision,
      source: repoRevisions.source,
      active: repoRevisions.active,
      verifiedAt: repoRevisions.verifiedAt,
      verifyError: repoRevisions.verifyError,
      gitSha: repoRevisions.gitSha,
      archiveBytes: repoRevisions.archiveBytes,
      createdAt: repoRevisions.createdAt,
    })
    .from(repoRevisions)
    .where(eq(repoRevisions.repoId, repo.id))
    .orderBy(desc(repoRevisions.revision))
    .limit(20);

  const members = await db
    .select({
      id: datasets.id,
      name: datasets.name,
      title: datasets.title,
      status: datasets.status,
      statusError: datasets.statusError,
      repoDir: datasets.repoDir,
      createdAt: datasets.createdAt,
      isPublic: datasets.isPublic,
      /** Still served from per-file rows: no model of its own carries a revision. */
      legacyModels: sql<number>`(
        select count(*) from ${malloyModels}
        where ${malloyModels.datasetId} = ${datasets.id} and ${malloyModels.revisionId} is null
      )`,
    })
    .from(datasets)
    // A failed load is not a dataset. It is a creation that did not happen, and
    // because the name index is partial on `ready` it does not even hold its own
    // name — so a retry leaves another beside it. One repo here collected six in
    // thirteen minutes that way. Listing them says six things exist when none do.
    //
    // They cannot recur: a create now publishes a revision first and makes the
    // rows inside that transaction, so a failure makes nothing. These are
    // historical, and the only reason not to delete them outright is that it is
    // not this endpoint's business.
    .where(and(eq(datasets.repoId, repo.id), ne(datasets.status, "failed")))
    .orderBy(asc(datasets.name));

  // Counted on the detail read rather than behind its own endpoint: the page
  // that offers the removal is this page, and a warning fetched separately is a
  // warning that can fail to arrive while the button stays live.
  const impact = await removalImpact(repo.id, repo.slug, members.map((d) => d.name));

  return NextResponse.json({
    id: repo.id,
    slug: repo.slug,
    removalImpact: impact,
    title: repo.title,
    githubRepo: repo.githubRepo,
    githubBranch: repo.githubBranch,
    githubUseToken: repo.githubUseToken,
    createdAt: repo.createdAt,
    // Null means nothing has been published yet — for an instance that upgraded,
    // it means this repo has never been refetched since.
    live: live ? { revision: live.revision, verifiedAt: live.verifiedAt, gitSha: live.gitSha } : null,
    needsUpdate: !live,
    history,
    datasets: members.map((d) => ({
      ...d,
      qualified: qualifiedName(repo.slug, d.name),
      displayTitle: datasetTitle(d.name, d.title),
      // The file this dataset is, rather than the directory it is in. A dataset
      // at the repo root has no directory to name, and "no directory" described
      // an absence instead of the thing that is there.
      entryFile: `./${repoPath(d.repoDir, "index.malloy")}`,
    })),
  });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let me;
  try {
    me = await getSessionUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "sign in required" }, { status: 401 });
    throw err;
  }
  if (!isAdmin(me)) return NextResponse.json({ error: "admin required" }, { status: 403 });

  const { id } = await ctx.params;
  const repo = await load(id);
  if (!repo) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as {
    githubRepo?: string | null;
    githubBranch?: string | null;
    githubUseToken?: boolean;
  } | null;
  if (!body) return NextResponse.json({ error: "bad request" }, { status: 400 });

  const patch: Record<string, unknown> = {};

  if (body.githubRepo !== undefined) {
    const slug = body.githubRepo?.trim() || null;
    if (slug) {
      // Validated here rather than discovered at the next refresh. An unparseable
      // slug is stored happily and then fails inside `repoContext`, where the
      // refresh button reports it as a server error rather than as the typo it is.
      try {
        parseGitHubRepo(slug);
      } catch {
        return NextResponse.json(
          { error: `"${slug}" is not an owner/name GitHub repo` },
          { status: 400 },
        );
      }
      // One repo per coordinate: two rows claiming the same branch of the same
      // GitHub repo is what made "which datasets are this repo" ambiguous before
      // repos were rows at all.
      // Coalesced on BOTH sides, matching `repos_github_unique`. A blank branch
      // is not a third value — the refresh path reads it as `main` — so
      // attaching with the branch left empty must clash with an existing row on
      // `main`. Comparing NULL to NULL found nothing, so the pre-check passed,
      // the index did not catch it either (NULLs are distinct in Postgres), and
      // two repos ended up pulling one commit.
      const branch = (body.githubBranch ?? repo.githubBranch)?.trim() || null;
      const [clash] = await db
        .select({ slug: repos.slug })
        .from(repos)
        .where(
          and(
            eq(repos.githubRepo, slug),
            sql`coalesce(${repos.githubBranch}, 'main') = ${branch ?? "main"}`,
          ),
        )
        .limit(1);
      if (clash && clash.slug !== repo.slug) {
        return NextResponse.json(
          { error: `${slug}@${branch ?? "(default)"} is already attached to the repo "${clash.slug}"` },
          { status: 409 },
        );
      }
    }
    patch.githubRepo = slug;
  }
  if (body.githubBranch !== undefined) patch.githubBranch = body.githubBranch?.trim() || null;
  if (body.githubUseToken !== undefined) patch.githubUseToken = body.githubUseToken;

  if (Object.keys(patch).length === 0) return NextResponse.json({ error: "nothing to change" }, { status: 400 });

  const [updated] = await db.update(repos).set(patch).where(eq(repos.id, repo.id)).returning();
  logger.info("repo settings changed", { repo: updated.slug, fields: Object.keys(patch) });

  return NextResponse.json({
    id: updated.id,
    slug: updated.slug,
    githubRepo: updated.githubRepo,
    githubBranch: updated.githubBranch,
    githubUseToken: updated.githubUseToken,
  });
}

/**
 * `DELETE /api/repos/:id` — remove this repository from the server.
 *
 * Deletes the repo, every dataset it publishes, and everything hanging off
 * those datasets: aliases, models, artifacts, model files, saved queries,
 * drafts, and every stored revision. One statement does it, because the foreign
 * keys cascade; see `removalImpact` for why that is worth being loud about.
 *
 * Guarded by `?confirm=<slug>` rather than by a bare DELETE. The destructive
 * reach here is wide and nothing about it is recoverable — the revisions ARE
 * the stored copies of the repo, so there is no "re-activate the old one"
 * afterwards. Naming the thing is what makes a mis-aimed call (a stale tab, a
 * script looping over slugs, a copied curl) fail instead of succeed. The slug
 * is in the URL already, so this is deliberately redundant: that is the point.
 *
 * What survives, on purpose:
 *  - `history` rows, whose `dataset_id` is ON DELETE SET NULL. The record that
 *    a query ran is not the dataset's to take with it.
 *  - `chats`, which reference a dataset by NAME with no foreign key. They end
 *    up pointing at a name nothing resolves, which is why the count is
 *    reported — but they are somebody's own questions, and removing a repo is
 *    not consent to delete them.
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let me;
  try {
    me = await getSessionUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "sign in required" }, { status: 401 });
    throw err;
  }
  if (!isAdmin(me)) return NextResponse.json({ error: "admin required" }, { status: 403 });

  const { id } = await ctx.params;
  const repo = await load(id);
  if (!repo) return NextResponse.json({ error: "not found" }, { status: 404 });

  const confirm = new URL(req.url).searchParams.get("confirm");
  if (confirm !== repo.slug) {
    return NextResponse.json(
      {
        error: `removing a repository is not reversible — pass ?confirm=${repo.slug} to do it`,
        slug: repo.slug,
      },
      { status: 400 },
    );
  }

  // Read the members BEFORE the delete: afterwards there is nothing to count,
  // and the response is the only record the caller gets of what went.
  const members = await db
    .select({ name: datasets.name })
    .from(datasets)
    .where(eq(datasets.repoId, repo.id));
  const impact = await removalImpact(repo.id, repo.slug, members.map((d) => d.name));

  await db.delete(repos).where(eq(repos.id, repo.id));

  logger.warn("repo removed", {
    repo: repo.slug,
    by: me.id,
    githubRepo: repo.githubRepo,
    ...impact,
  });
  void captureTelemetry(
    {
      event: "repo removed",
      properties: {
        datasets: impact.datasets,
        revisions: impact.revisions,
        saved_queries: impact.savedQueries,
        drafts: impact.drafts,
        orphaned_chats: impact.orphanedChats,
      },
    },
    me.id,
  );

  return NextResponse.json({
    ok: true,
    slug: repo.slug,
    removed: impact,
    // Said back explicitly, because it is the one thing the cascade did NOT
    // handle and the admin may want to go deal with it.
    orphanedChats: impact.orphanedChats,
  });
}
