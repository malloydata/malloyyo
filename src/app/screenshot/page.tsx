// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The page a screenshot service renders: ONE dashboard as ONE user, named by
// the screenshot token the service sends on every request (screenshot-token.ts).
// No session and no nav — the token is the only way in, and without one this
// page does not exist (404), so a person browsing to it sees nothing.
//
// It mounts the SAME renderers as /datasets/[id]/dashboard/[name], against the
// same routes, so the picture is what a person opening the dashboard would
// see. Those routes accept the token only for this dataset ref + dashboard
// name (viewer.ts).
import { notFound, redirect } from "next/navigation";
import { getAuthorizedUser, UnauthorizedError } from "@/lib/user";
import { getDashboard, isCustomDashboard } from "@/lib/dashboards";
import { screenshotClaims } from "@/lib/dashboards/viewer";
import { CustomDashboardFrame } from "../datasets/[id]/dashboard/[name]/CustomDashboardFrame";
import { TagOnlyDashboard } from "../datasets/[id]/dashboard/[name]/TagOnlyDashboard";

export const metadata = { robots: { index: false, follow: false } };

export default async function ScreenshotPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  let claims;
  try {
    claims = await screenshotClaims();
  } catch (err) {
    if (err instanceof UnauthorizedError) notFound();
    throw err;
  }
  if (!claims) notFound();

  let user;
  try {
    user = await getAuthorizedUser(claims.userId);
  } catch (err) {
    if (err instanceof UnauthorizedError) notFound();
    throw err;
  }
  const dash = await getDashboard(user.id, claims.datasetId, claims.name);
  if (!dash) notFound();

  // The renderers read their opening givens from the URL (`?$NAME=…`), exactly
  // as a shared link does — so put the token's givens there rather than teach
  // them a second way in.
  const given = Object.entries(claims.givens).filter(([, v]) => v !== "");
  const params = await searchParams;
  if (given.some(([k, v]) => params[`$${k}`] !== v)) {
    const qs = new URLSearchParams(given.map(([k, v]) => [`$${k}`, v]));
    redirect(`/screenshot?${qs}`);
  }

  return (
    // No title of our own: a dashboard draws its own, as on its real page.
    <main className="w-full px-6 py-5">
      {isCustomDashboard(dash) ? (
        <CustomDashboardFrame id={claims.datasetId} name={claims.name} />
      ) : (
        <TagOnlyDashboard id={claims.datasetId} name={claims.name} />
      )}
    </main>
  );
}
