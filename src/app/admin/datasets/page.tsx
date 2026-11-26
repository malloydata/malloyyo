// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Admin → Datasets: every dataset on this instance, under the repo that
// publishes it.
//
// Grouped by repo because that is what is true of them: a repo is fetched,
// verified and made live as one thing, so "which commit is this serving, and
// since when" has one answer per repo, said once above its datasets rather
// than repeated on each. Changing any of that is the repo's own page
// (/repos/<slug>), which this links to.
//
// What IS decided here is row scoping: the givens every model published to a
// dataset must declare. Who opens a dataset is shown, because it is the other
// half of "who sees what in here", but it is set on Admin → Roles — one place
// to change a level, not two that can be left disagreeing.

import Link from "next/link";
import { and, asc, eq } from "drizzle-orm";
import { db, datasets, givens as givensTable, repoRevisions, repos, users } from "@/db";
import { requireAdminPage } from "@/lib/admin";
import { resolveAccess, roleLevelOn } from "@/lib/role-access";
import { qualifiedName } from "@/lib/repo-names";
import { MALLOYYO_ADMIN, rolesOf } from "@/lib/roles";
import { datasetTitle } from "@malloyyo/mcp-engine";
import { LevelRows, MUTED, PRIMARY } from "../access-shared";
import { DatasetGivens } from "../roles/role-controls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GRID = "grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1.2fr)] gap-4";
const TAG = "rounded border border-gray-400 px-1 text-xs font-normal text-gray-600 dark:border-gray-600 dark:text-gray-400";

export default async function AdminDatasetsPage() {
  await requireAdminPage();

  const [repoRows, live, dsRows, people, givenCatalog] = await Promise.all([
    db
      .select({
        id: repos.id,
        slug: repos.slug,
        githubRepo: repos.githubRepo,
        githubBranch: repos.githubBranch,
        githubUseToken: repos.githubUseToken,
      })
      .from(repos)
      .orderBy(asc(repos.slug)),
    // What each repo serves. Columns named, never `select()`: a revision row
    // carries the whole archive, and this page wants five small facts about it.
    db
      .select({
        repoId: repoRevisions.repoId,
        revision: repoRevisions.revision,
        gitSha: repoRevisions.gitSha,
        source: repoRevisions.source,
        activatedAt: repoRevisions.activatedAt,
        createdById: repoRevisions.createdById,
      })
      .from(repoRevisions)
      .where(and(eq(repoRevisions.active, true), eq(repoRevisions.preview, false))),
    // Ready datasets only, as on Admin → Roles: a failed or half-built row
    // cannot be opened by anyone, and listing it means two rows with one label.
    db
      .select({
        id: datasets.id,
        name: datasets.name,
        title: datasets.title,
        description: datasets.description,
        roles: datasets.roles,
        viewOnlyRoles: datasets.viewOnlyRoles,
        ownerId: datasets.userId,
        requiredGivens: datasets.requiredGivens,
        repoId: datasets.repoId,
        repoDir: datasets.repoDir,
      })
      .from(datasets)
      .where(eq(datasets.status, "ready"))
      .orderBy(asc(datasets.name)),
    db.select().from(users).where(eq(users.status, "active")),
    db.select().from(givensTable).orderBy(asc(givensTable.name)),
  ]);

  const liveOf = new Map(live.map((r) => [r.repoId, r]));
  const nameOf = new Map(people.map((u) => [u.id, u.name ?? u.email]));
  const givenList = givenCatalog.map((g) => ({ name: g.name, description: g.description }));
  // Everyone who is not an admin, with the roles the server reads for them.
  // Admins open every dataset, so counting them says nothing about a dataset.
  const others = people
    .map((u) => ({ id: u.id, roles: rolesOf(u) }))
    .filter((u) => !u.roles.includes(MALLOYYO_ADMIN));

  const groups = [
    ...repoRows.map((r) => ({ repo: r, rows: dsRows.filter((d) => d.repoId === r.id) })),
    { repo: null, rows: dsRows.filter((d) => d.repoId === null) },
  ].filter((g) => g.repo !== null || g.rows.length > 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2.5">
          <h2 className="text-base font-semibold">Datasets</h2>
          <span className={MUTED}>
            {dsRows.length} {dsRows.length === 1 ? "dataset" : "datasets"}, {repoRows.length}{" "}
            {repoRows.length === 1 ? "repo" : "repos"}
          </span>
        </div>
        <Link href="/datasets/new/github" className={PRIMARY}>
          Add from GitHub
        </Link>
      </div>

      {groups.length === 0 && (
        <p className={MUTED}>Nothing published yet. Add a Malloy model repo from GitHub to begin.</p>
      )}

      {groups.map(({ repo, rows }) => {
        const rev = repo ? liveOf.get(repo.id) : undefined;
        return (
          <section
            key={repo?.id ?? "no-repo"}
            className={`overflow-hidden rounded-md border ${
              repo ? "border-gray-200 dark:border-gray-800" : "border-dashed border-gray-400 dark:border-gray-600"
            }`}
          >
            <div className="flex items-center justify-between gap-4 border-b border-gray-200 bg-gray-50 px-4 py-2.5 dark:border-gray-800 dark:bg-gray-900">
              {repo ? (
                <>
                  <div className="min-w-0 flex-1">
                    <h3 className="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold">
                      <span className="break-all">{repo.githubRepo ?? repo.slug}</span>
                      {repo.githubRepo && (
                        <span className="font-normal text-gray-600 dark:text-gray-400">
                          @ {repo.githubBranch ?? "main"}
                        </span>
                      )}
                      {repo.githubRepo && repo.githubUseToken && <span className={TAG}>reads with token</span>}
                    </h3>
                    <p className={MUTED}>
                      {rev
                        ? [
                            `revision ${rev.revision}`,
                            ...(rev.gitSha ? [rev.gitSha.slice(0, 7)] : []),
                            ...(rev.activatedAt ? [`live since ${rev.activatedAt.toISOString().slice(0, 10)}`] : []),
                            (rev.source === "cli" ? "published from the CLI" : "fetched from GitHub") +
                              (rev.createdById && nameOf.get(rev.createdById)
                                ? ` by ${nameOf.get(rev.createdById)}`
                                : ""),
                          ].join(" · ")
                        : repo.githubRepo
                          ? "Nothing live yet."
                          : "Not attached to GitHub. Nothing live yet."}
                    </p>
                  </div>
                  <Link
                    href={`/repos/${encodeURIComponent(repo.slug)}`}
                    className="shrink-0 rounded border border-gray-300 bg-white px-2.5 py-1 text-xs hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-950 dark:hover:bg-gray-900"
                  >
                    Repo settings
                  </Link>
                </>
              ) : (
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold">Not in a repo</h3>
                  <p className={MUTED}>Published before repos. Nothing refreshes these.</p>
                </div>
              )}
            </div>

            {rows.length === 0 ? (
              <p className={`${MUTED} px-4 py-3`}>No datasets from this repo are live.</p>
            ) : (
              <div className="overflow-x-auto">
                <div className="min-w-[36rem]">
                  <div className={`${GRID} border-b border-gray-100 px-4 py-1.5 text-xs text-gray-600 dark:border-gray-800 dark:text-gray-400`}>
                    <span>Dataset</span>
                    <span>Rows scoped by</span>
                    <span>Opened by</span>
                  </div>
                  {rows.map((d) => {
                    const ref = qualifiedName(repo?.slug, d.name);
                    const full = (d.roles ?? []).filter((r) => roleLevelOn(d, r) === "query");
                    const dash = (d.roles ?? []).filter((r) => roleLevelOn(d, r) === "view");
                    const reach = others.filter(
                      (u) => resolveAccess(u.roles, [d], { userId: u.id })[0].level !== "none",
                    ).length;
                    return (
                      <div
                        key={d.id}
                        className={`${GRID} items-start border-b border-gray-100 px-4 py-3 last:border-0 dark:border-gray-800`}
                      >
                        <div className="min-w-0">
                          <Link
                            href={`/datasets/${encodeURIComponent(ref)}/config`}
                            className="text-sm font-semibold hover:underline"
                          >
                            {datasetTitle(d.name, d.title)}
                          </Link>
                          <div className={`break-all ${MUTED}`}>{ref}</div>
                          {repo && <div className={`break-all ${MUTED}`}>{d.repoDir ? d.repoDir : "repo root"}</div>}
                        </div>
                        <DatasetGivens
                          key={(d.requiredGivens ?? []).join(",")}
                          datasetId={d.id}
                          all={givenList}
                          required={d.requiredGivens ?? []}
                        />
                        <div className="flex flex-col gap-1.5">
                          <LevelRows
                            rows={[
                              ...(full.length > 0 ? [{ level: "query" as const, text: full.join(", ") }] : []),
                              ...(dash.length > 0 ? [{ level: "view" as const, text: dash.join(", ") }] : []),
                            ]}
                          />
                          <span className={MUTED}>
                            {reach === 0
                              ? "Nobody but admins yet."
                              : `${reach} ${reach === 1 ? "person" : "people"}, and admins.`}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </section>
        );
      })}

      <p className={`${MUTED} max-w-2xl`}>
        Scoping narrows the rows inside a dataset to whoever is asking. Tick one and every model published to that
        dataset has to declare it; a publish that does not is refused. Who opens a dataset is set on{" "}
        <Link href="/admin/roles" className="underline">
          Roles
        </Link>
        .
      </p>
    </div>
  );
}
