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
import { dashboardViewData, isCustomDashboard } from "@/lib/dashboards";
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

  const view = await dashboardViewData(user.id, id, name);
  if (!view) notFound();

  return (
    <main className="w-full px-6 py-5">
      <DatasetNav datasetId={id} activeDashboard={name} />
      {isCustomDashboard(view.dash) ? (
        <CustomDashboardFrame id={id} name={name} />
      ) : (
        <TagOnlyDashboard id={id} name={name} info={view.info} givenSpecs={view.givenSpecs} />
      )}
    </main>
  );
}
