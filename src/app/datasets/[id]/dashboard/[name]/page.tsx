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
import { getSessionUser, UnauthorizedError } from "@/lib/user";
// Only DB-backed helpers here (no Malloy/DuckDB) — a page render function can't
// load libduckdb.so and 500s. The tag-only info + given specs (which DO need
// Malloy) are fetched by TagOnlyDashboard from the /view API route. See
// reference_ssr_page_duckdb_500.
import { getDashboard, isCustomDashboard } from "@/lib/dashboards";
import { CustomDashboardFrame } from "./CustomDashboardFrame";
import { TagOnlyDashboard } from "./TagOnlyDashboard";

export default async function DashboardViewPage({
  params,
}: {
  params: Promise<{ id: string; name: string }>;
}) {
  const { id, name } = await params;
  let user;
  try {
    user = await getSessionUser();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      const back = `/datasets/${id}/dashboard/${encodeURIComponent(name)}`;
      redirect(`/api/auth/signin?callbackUrl=${encodeURIComponent(back)}`);
    }
    throw err;
  }

  // DB read only (no DuckDB) — enough to branch custom (sandboxed iframe) vs
  // tag-only (in-page). The tag-only view data is fetched client-side.
  const dash = await getDashboard(user.id, id, name);
  if (!dash) notFound();

  return (
    <main className="w-full px-6 py-5">
      <DatasetNav datasetId={id} activeDashboard={name} />
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
