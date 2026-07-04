// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The sandboxed-iframe document for a dashboard: inlines the manifest and loads
// the bundled artifact. Served same-origin for now (dev); a production build
// would move this to a separate artifact origin (see docs/repo-artifacts.md §8).

import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { getDashboard } from "@/lib/dashboards";

export const runtime = "nodejs";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function GET(_req: Request, ctx: { params: Promise<{ datasetId: string; name: string }> }) {
  try {
    const user = await getSessionUser();
    const { datasetId, name } = await ctx.params;
    const dash = await getDashboard(user.id, datasetId, name);
    if (!dash) return new Response("dashboard not found", { status: 404 });
    const bundleUrl = `/api/dashboards/${datasetId}/${encodeURIComponent(name)}/bundle`;
    const html =
      `<!doctype html><html><head><meta charset="utf-8"><title>${esc(dash.title)}</title>` +
      `<meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
      `<body style="margin:0"><div id="root"></div>` +
      `<script src="/dashboard-vendor.js"></script>` +
      `<script>window.__MANIFEST__=${JSON.stringify(dash.manifest)}</script>` +
      `<script src="${bundleUrl}"></script></body></html>`;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  } catch (err) {
    if (err instanceof UnauthorizedError) return new Response("sign in required", { status: 401 });
    throw err;
  }
}
