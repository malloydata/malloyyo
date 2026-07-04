// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { getDashboard } from "@/lib/dashboards";
import { bundleDashboard } from "@/lib/dashboards/bundle";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ datasetId: string; name: string }> }) {
  try {
    const user = await getSessionUser();
    const { datasetId, name } = await ctx.params;
    const dash = await getDashboard(user.id, datasetId, name);
    if (!dash) return new Response("dashboard not found", { status: 404 });
    const js = await bundleDashboard(dash.source);
    return new Response(js, {
      headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" },
    });
  } catch (err) {
    if (err instanceof UnauthorizedError) return new Response("sign in required", { status: 401 });
    throw err;
  }
}
