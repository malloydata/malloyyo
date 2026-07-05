// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { getDashboard } from "@/lib/dashboards";
import { bundleDashboard } from "@/lib/dashboards/bundle";
import { verifyFrameToken } from "@/lib/dashboards/frame-token";

export const runtime = "nodejs";

// Authed by the frame's capability token (?t=), NOT the session cookie: this is
// fetched by the sandboxed opaque-origin iframe, which sends no cookie. The
// token is minted by the cookie-authed frame route for a specific viewer +
// dashboard; we scope getDashboard to that viewer so bundle visibility is
// unchanged. See docs/dashboard-iframe-security.md.
export async function GET(req: Request, ctx: { params: Promise<{ datasetId: string; name: string }> }) {
  const { datasetId, name } = await ctx.params;
  const token = new URL(req.url).searchParams.get("t") ?? "";
  const claims = verifyFrameToken(token);
  if (!claims || claims.datasetId !== datasetId || claims.name !== name) {
    return new Response("invalid or expired frame token", { status: 401 });
  }
  const dash = await getDashboard(claims.userId, datasetId, name);
  if (!dash) return new Response("dashboard not found", { status: 404 });
  const js = await bundleDashboard(dash.source);
  return new Response(js, {
    headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" },
  });
}
