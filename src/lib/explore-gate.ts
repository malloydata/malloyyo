// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The session-side gate for the surfaces a dashboard-only account does not
// have (`canExplore`, src/lib/roles.ts). The bearer side is one check in
// src/lib/bearer-auth.ts; a browser session reaches many routes, so each of
// them asks here.
//
// A route calls `dashboardOnlyRefusal(user)` right after it has a user; a
// server page calls `turnAwayDashboardOnly()`. What is deliberately NOT gated:
// anything a dashboard needs to draw — /api/dashboards/**, /api/me, the
// dataset pages that host a dashboard.
//
// A tier, not a wall — see `canExplore` for why that is the honest framing.

import { NextResponse } from "next/server";
import { redirect } from "next/navigation";
import { canExplore, DASHBOARD_ONLY_MESSAGE, type RoleBearing } from "./roles";
import { getSessionUserOrNull } from "./user";

/** A 403 for a dashboard-only caller, or null for everyone else. */
export function dashboardOnlyRefusal(user: RoleBearing): NextResponse | null {
  return canExplore(user) ? null : NextResponse.json({ error: DASHBOARD_ONLY_MESSAGE }, { status: 403 });
}

/** For a server PAGE that is itself a query surface: a dashboard-only account
    goes home, where its dashboards are. Signed-out callers are left to whatever
    the page already does about them. */
export async function turnAwayDashboardOnly(): Promise<void> {
  const user = await getSessionUserOrNull();
  if (user && !canExplore(user)) redirect("/");
}
