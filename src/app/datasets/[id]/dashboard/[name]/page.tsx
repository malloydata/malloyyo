// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Trusted shell for a dashboard, branching on how it renders:
//   • TAG-ONLY (no Dashboard.tsx) → the Malloy renderer runs DIRECTLY in this
//     trusted page, full-width, with NO iframe (TagOnlyDashboard). There's no
//     untrusted author code to sandbox, so the iframe bought nothing but
//     lifecycle pain (double-paint, src freeze, the 100vh box).
//   • CUSTOM (a Dashboard.tsx) → arbitrary repo-authored code, so it stays in
//     the sandboxed opaque-origin iframe (CustomDashboardFrame). Custom
//     dashboards draw themselves (VegaChart); they can't reach the Malloy
//     renderer — that only ever runs here, in the trusted page.
import { redirect, notFound } from "next/navigation";
import { DatasetNav } from "@/components/DatasetNav";
import { resolveDatasetRef } from "@/lib/repos";
import { canQueryDataset } from "@/lib/mcp-tools";
import { qualifiedName } from "@/lib/repo-names";
import { datasetTitle } from "@malloyyo/mcp-engine";
import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { signInPath } from "@/lib/auth-paths";
// Only DB-backed helpers here (no Malloy/DuckDB) — a page render function can't
// load libduckdb.so and 500s. The tag-only info + given specs (which DO need
// Malloy) are fetched by TagOnlyDashboard from the /view API route. See
// reference_ssr_page_duckdb_500.
import { draftForward, draftSlug, getDashboard, isCustomDashboard } from "@/lib/dashboards";
import { DashboardShare } from "@/components/DashboardShare";
import { isAdmin } from "@/lib/admin";
import { parsePreviewRef } from "@/lib/repo-previews";
import { sharedCount } from "@/lib/dashboards/sharing";
import { CustomDashboardFrame } from "./CustomDashboardFrame";
import { PreviewBanner } from "@/components/PreviewBanner";
import { TagOnlyDashboard } from "./TagOnlyDashboard";

export default async function DashboardViewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; name: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id, name } = await params;
  let user;
  try {
    user = await getSessionUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      const back = `/datasets/${id}/dashboard/${encodeURIComponent(name)}`;
      redirect(signInPath(back));
    }
    throw err;
  }

  // A promoted draft whose dashboard is now published: a saved link to the
  // draft goes to the real one, keeping any query string (givens) it carried.
  const forward = await draftForward(user.id, id, name);
  if (forward) {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(await searchParams)) {
      for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) query.append(k, one);
    }
    const qs = query.toString();
    redirect(`/datasets/${id}/dashboard/${encodeURIComponent(forward)}${qs ? `?${qs}` : ""}`);
  }

  // DB read only (no DuckDB) — enough to branch custom (sandboxed iframe) vs
  // tag-only (in-page). The tag-only view data is fetched client-side.
  const dash = await getDashboard(user.id, id, name);
  if (!dash) notFound();

  // Resolved here so the nav paints the dataset's real name and builds correct
  // links on the FIRST render. It used to show the raw route param until a
  // client fetch replaced it.
  const ref = await resolveDatasetRef(id);
  // What to offer beside the dashboard. Someone whose roles on this dataset are
  // view-only gets the dashboards and no ways into the data that aren't one.
  //
  // A branch preview is not a dataset `resolveDatasetRef` knows — its address
  // names a repo and a branch — and it is an admin's own fetch, reached only
  // through `getDashboard` above, which has already refused anyone else. So it
  // is always queryable; treating "did not resolve" as "may not query" took the
  // query links off every preview.
  const isPreview = parsePreviewRef(id) !== null;
  const canQuery = isPreview || (ref.ok ? await canQueryDataset(user.id, ref.dataset.id) : false);
  const navLabel = ref.ok ? datasetTitle(ref.dataset.name, ref.dataset.title) : undefined;
  const navRef = ref.ok && ref.repo ? qualifiedName(ref.repo.slug, ref.dataset.name) : ref.ok ? ref.dataset.name : undefined;
  // Who may change who sees it: a draft's author or an admin; for a published
  // dashboard, an admin. The same rule the sharing route enforces
  // (src/lib/dashboards/sharing.ts) — this only decides whether to draw the
  // button. A branch preview has no audience to manage.
  const canManage = !isPreview && (isAdmin(user) || (dash.draft !== undefined && dash.draft.authorId === user.id));
  // How many people it is shared with, for the label beside Share — so it reads
  // the same before the dialog has been opened as after.
  const sharedWith = canManage && dash.isPrivate && ref.ok ? await sharedCount(ref.dataset.id, name) : 0;

  return (
    <main className="w-full px-6 py-5">
      <DatasetNav
        datasetId={id}
        datasetLabel={navLabel}
        datasetRef={navRef}
        activeDashboard={name}
        activeTitle={dash.title}
        canQuery={canQuery}
        isDraft={!!dash.draft}
        extras={
          canManage ? (
            <DashboardShare
              datasetRef={id}
              dashboard={name}
              title={dash.title}
              kind={dash.draft ? "draft" : "published"}
              visibility={dash.isPrivate ? "private" : "dataset"}
              sharedCount={sharedWith}
              datasetTitle={navLabel ?? dash.datasetName}
              draftSlug={dash.draft ? (draftSlug(name) ?? name) : undefined}
            />
          ) : dash.isPrivate ? (
            // Shared with this reader, who cannot change that — but should know
            // the link they are looking at does not open for everyone.
            <span className="text-gray-600 dark:text-gray-400">Private · shared with you</span>
          ) : null
        }
      />
      <PreviewBanner userId={user.id} datasetRef={id} dashboard={name} />
      {dash.draft?.promotedAs ? (
        // The one thing about a draft that still needs a sentence: where its
        // link is about to start going.
        <p role="status" className="mb-3 text-xs text-gray-600 dark:text-gray-400">
          Promoted as <code>{dash.draft.promotedAs}</code>. This link will open that dashboard once the model
          carrying it is published.
        </p>
      ) : null}
      {isCustomDashboard(dash) ? (
        <CustomDashboardFrame key={`${id}/${name}`} id={id} name={name} />
      ) : (
        // key per dashboard: switching via the nav fully remounts the island, so
        // the vendor React root is torn down and rebuilt cleanly.
        <TagOnlyDashboard key={`${id}/${name}`} id={id} name={name} />
      )}
    </main>
  );
}
