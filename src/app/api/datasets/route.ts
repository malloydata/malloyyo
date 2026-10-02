// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * `POST /api/datasets` — add a GitHub repo to this instance.
 *
 * It is named after datasets because that is what it produces and what its
 * caller (the "add a dataset" form) asks for, but what it now CREATES is a repo:
 * a row with an owner, a branch and one answer about its credential, attached to
 * GitHub deliberately. Its first revision is pulled, verified and activated by
 * the same pipeline a CLI publish and a webhook push use.
 *
 * The response shape is unchanged — one dataset answers as it always did, so
 * nothing that adds a single repo has to learn a new shape; several answer with
 * the list — plus the repo and the qualified names, which are additive.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { and, desc, eq, ne } from "drizzle-orm";
import { nameToSlug as engineSlug } from "@malloyyo/mcp-engine";
import { db, datasets, malloyModels, repoRevisions, repos, users } from "@/db";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { isAdmin } from "@/lib/admin";
import { canAuthor, datasetVisibleWhere } from "@/lib/roles";
import { nameToSlug } from "@/lib/slug";
import { parseGitHubRepo } from "@/lib/github";
import { fetchRepo } from "@/lib/github-refresh";
import { publishRevision } from "@/lib/repo-publish";
import { repoSlugFromGitHub } from "@/lib/repos";
import { logger, serializeErr } from "@/lib/logger";
import { captureTelemetry } from "@/lib/telemetry";

export const runtime = "nodejs";

const GitHubBody = z.object({
  githubRepo: z.string().min(1),
  githubBranch: z.string().min(1).default("main"),
  /** The dataset name for a single-dataset repo; also the repo's name unless
      `repoSlug` says otherwise. In a multi-dataset repo the DIRECTORIES name the
      datasets, so this only names the repo. */
  name: z.string().min(1).max(64),
  useToken: z.boolean().default(true),
  /** Name the repo explicitly. Optional — defaults to the GitHub repo's name. */
  repoSlug: z.string().min(1).max(64).optional(),
});

export async function POST(req: Request) {
  let user;
  try {
    user = await getSessionUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: "sign in required" }, { status: 401 });
    throw err;
  }
  // Admin only. Adding a repo means naming a codebase this server will compile,
  // and compiling resolves schemas by running SQL against this server's own
  // configured connections — see canAuthor.
  if (!canAuthor(user)) {
    return NextResponse.json({ error: "MALLOYYO_ADMIN required" }, { status: 403 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  let body: ReturnType<typeof GitHubBody.parse>;
  try {
    body = GitHubBody.parse(raw);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 400 });
  }
  try {
    parseGitHubRepo(body.githubRepo);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 400 });
  }

  const branch = body.githubBranch;
  const slug = body.repoSlug ? engineSlug(body.repoSlug) : repoSlugFromGitHub(body.githubRepo);
  if (!slug) {
    return NextResponse.json({ error: `could not make a repo name out of "${body.githubRepo}"` }, { status: 400 });
  }

  // One repo per (github_repo, branch) and one per name. Both are checked here
  // so the caller gets a sentence rather than a unique-violation; the indexes
  // are what make it true under a race.
  const [bySlug] = await db.select().from(repos).where(eq(repos.slug, slug)).limit(1);
  // AN EMPTY REPO IS REUSED, not refused.
  //
  // This route creates the repo row before pulling, and removes it again if
  // nothing lands. That delete is a compensating action, which is exactly what
  // this rewrite set out to get rid of — so it must not be the only thing
  // standing between a crashed request and a permanently unusable name. If the
  // process dies between the insert and the delete, what is left is a repo with
  // no datasets and no live revision: it serves nothing, and RETRYING THE SAME
  // REQUEST now simply picks it up. The delete is a tidy-up, not a correctness
  // requirement.
  const reusable =
    bySlug &&
    (await db.select({ id: datasets.id }).from(datasets).where(eq(datasets.repoId, bySlug.id)).limit(1))
      .length === 0 &&
    (
      await db
        .select({ id: repoRevisions.id })
        .from(repoRevisions)
        .where(and(eq(repoRevisions.repoId, bySlug.id), eq(repoRevisions.active, true)))
        .limit(1)
    ).length === 0;
  if (bySlug && !reusable) {
    return NextResponse.json(
      {
        error:
          `this instance already has a repo named "${slug}"` +
          (bySlug.githubRepo ? ` (${bySlug.githubRepo}@${bySlug.githubBranch})` : "") +
          `. Two repos cannot share a name — their datasets would share a namespace.`,
      },
      { status: 409 },
    );
  }
  const [attached] = await db
    .select()
    .from(repos)
    .where(and(eq(repos.githubRepo, body.githubRepo), eq(repos.githubBranch, branch)))
    .limit(1);
  if (attached && attached.id !== bySlug?.id) {
    return NextResponse.json(
      { error: `${body.githubRepo}@${branch} is already on this instance as the repo "${attached.slug}"` },
      { status: 409 },
    );
  }

  // The repo row goes in FIRST and on its own, and the tidy-up below removes it
  // only if THIS REQUEST CREATED IT. A reused row (see `reusable` above) is
  // somebody else's: `repos → repo_revisions` is `ON DELETE cascade`, so
  // deleting one would destroy that repo's whole stored archive history over a
  // failed GitHub pull.
  //
  // Leaving a created-and-empty repo behind is not a compensating-action hazard
  // the way a `ready` dataset row was: it serves nothing, holds no dataset name,
  // and an identical retry reuses it. The delete is a courtesy.
  // Only a row this request INSERTED may be removed again. `reusable` means we
  // updated one that was already there.
  const createdHere = !reusable;
  let repo: typeof repos.$inferSelect;
  const tidyUp = async () => {
    if (!createdHere) return;
    await db.delete(repos).where(eq(repos.id, repo.id)).catch(() => {});
  };

  try {
    [repo] = reusable
      ? await db
          .update(repos)
          .set({
            ownerId: user.id,
            githubRepo: body.githubRepo,
            githubBranch: branch,
            githubUseToken: body.useToken,
            updatedAt: new Date(),
          })
          .where(eq(repos.id, bySlug!.id))
          .returning()
      : await db
          .insert(repos)
          .values({
            slug,
            ownerId: user.id,
            githubRepo: body.githubRepo,
            githubBranch: branch,
            githubUseToken: body.useToken,
          })
          .returning();
  } catch (err) {
    logger.info("repo create raced", { slug, ...serializeErr(err) });
    return NextResponse.json({ error: `the repo "${slug}" was just created by someone else` }, { status: 409 });
  }

  const telemetry = (outcome: "success" | "error") =>
    void captureTelemetry(
      {
        event: "model published",
        properties: {
          method: "github_create",
          outcome,
          created_dataset: true,
          source_count: 0,
          file_count: 0,
          dashboard_count: 0,
        },
      },
      user.id,
    );

  try {
    const fetched = await fetchRepo(repo);
    if (!fetched.ok) {
      await tidyUp();
      telemetry("error");
      return NextResponse.json({ error: fetched.error }, { status: 502 });
    }

    const result = await publishRevision({
      repo,
      raw: fetched.zip,
      source: "github",
      createdById: user.id,
      git: { sha: fetched.sha, branch: fetched.branch, dirty: false },
      // The whole point of this route: the datasets do not exist yet.
      createDatasets: true,
      datasetOwnerId: user.id,
      // A single-dataset repo has no directory to be named after, so the form's
      // `name` names it. The same field names the repo, which is why a repo and
      // its one dataset normally share a name.
      rootDatasetName: nameToSlug(body.name),
    });

    if (!result.ok) {
      // Removed because NOTHING of it landed and nobody asked for an empty repo
      // — this route's contract is "a repo with datasets, or an error". Only a
      // row this request created, though: `repo_revisions` cascades from
      // `repos`, so deleting a REUSED row would throw away that repo's stored
      // archive history. And unlike the dataset rows the old version deleted,
      // leaving this one behind is survivable: it serves nothing and a retry
      // reuses it, so this is tidy-up and not correctness.
      await tidyUp();
      telemetry("error");
      logger.error("repo create failed", {
        repo: body.githubRepo,
        branch,
        kind: result.kind,
        error: result.error,
      });
      return NextResponse.json(
        { error: result.error, status: "failed", ...(result.failures ? { failures: result.failures } : {}) },
        { status: result.kind === "request" ? 400 : 422 },
      );
    }

    telemetry("success");
    const created = result.datasets;
    if (created.length === 1) {
      // `sources` is what the add-a-repo form prints back ("3 sources"), so it
      // has to be the real list. It comes off the model the activation wrote
      // rather than being threaded out of the pipeline, which would make every
      // other caller carry it.
      const [model] = await db
        .select({ sources: malloyModels.sources })
        .from(malloyModels)
        .where(and(eq(malloyModels.datasetId, created[0].id), eq(malloyModels.active, true)))
        .limit(1);
      return NextResponse.json({
        id: created[0].id,
        name: created[0].name,
        qualified: created[0].qualified,
        repo: repo.slug,
        status: "ready",
        sources: model?.sources ?? [],
      });
    }
    return NextResponse.json({
      status: "ready",
      repo: repo.slug,
      datasets: created.map((c) => ({
        id: c.id,
        name: c.name,
        qualified: c.qualified,
        repoDir: c.dir,
      })),
    });
  } catch (err) {
    await tidyUp();
    telemetry("error");
    logger.error("POST /api/datasets uncaught error", { repo: body.githubRepo, ...serializeErr(err) });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err), status: "failed" },
      { status: 500 },
    );
  }
}

export async function GET() {
  let user;
  try {
    user = await getSessionUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      const rows = await db
        .select({
          id: datasets.id,
          name: datasets.name,
          status: datasets.status,
          createdAt: datasets.createdAt,
          readyAt: datasets.readyAt,
          isPublic: datasets.isPublic,
          repo: repos.slug,
        })
        .from(datasets)
        .leftJoin(repos, eq(datasets.repoId, repos.id))
        .where(and(eq(datasets.isPublic, true), ne(datasets.status, "failed")))
        .orderBy(desc(datasets.createdAt))
        .limit(50);
      return NextResponse.json(rows);
    }
    throw err;
  }

  if (isAdmin(user)) {
    const rows = await db
      .select({
        id: datasets.id,
        name: datasets.name,
        status: datasets.status,
        createdAt: datasets.createdAt,
        readyAt: datasets.readyAt,
        isPublic: datasets.isPublic,
        repo: repos.slug,
        ownerEmail: users.email,
        ownerName: users.name,
        ownerId: users.id,
      })
      .from(datasets)
      .leftJoin(users, eq(datasets.userId, users.id))
      .leftJoin(repos, eq(datasets.repoId, repos.id))
      .where(ne(datasets.status, "failed"))
      .orderBy(desc(datasets.createdAt))
      .limit(50);
    return NextResponse.json(rows);
  }

  // Owned, public, or opened by one of their roles — the same predicate the run
  // paths use, so a dataset someone can query is a dataset they can see listed.
  const rows = await db
    .select({
      id: datasets.id,
      name: datasets.name,
      status: datasets.status,
      createdAt: datasets.createdAt,
      readyAt: datasets.readyAt,
      isPublic: datasets.isPublic,
      repo: repos.slug,
    })
    .from(datasets)
    .leftJoin(repos, eq(datasets.repoId, repos.id))
    .where(datasetVisibleWhere(user.id))
    .orderBy(desc(datasets.createdAt))
    .limit(50);
  return NextResponse.json(rows);
}
