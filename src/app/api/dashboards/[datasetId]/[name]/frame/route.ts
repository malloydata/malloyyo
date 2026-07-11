// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The sandboxed-iframe document for a dashboard: inlines the manifest and loads
// the bundled artifact. The iframe runs with sandbox="allow-scripts" (opaque
// origin, no session cookie), so this route — reached by the cookie-authed
// subframe navigation — mints a short-lived capability token and hands it to the
// bundle URL so the guest can load its own compiled code without a cookie.
// A separate artifact origin is the remaining hardening (docs/repo-artifacts.md
// §8, docs/dashboard-iframe-security.md).

import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { getDashboard, dashboardGivens } from "@/lib/dashboards";
import { mintFrameToken } from "@/lib/dashboards/frame-token";

export const runtime = "nodejs";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function GET(req: Request, ctx: { params: Promise<{ datasetId: string; name: string }> }) {
  try {
    const user = await getSessionUser();
    const { datasetId, name } = await ctx.params;
    const dash = await getDashboard(user.id, datasetId, name);
    if (!dash) return new Response("dashboard not found", { status: 404 });
    // Given specs introspected from the MODEL's given: declarations (types,
    // defaults, labels, suggestion queries) — the runtime's control contract.
    const specs = await dashboardGivens(user.id, datasetId, name);
    const givenSpecs = specs.ok ? specs.givens : [];
    // Initial givens (filter values) from the query → the dashboard seeds from
    // these so a shared/deep link opens in that state.
    const initialGivens: Record<string, string> = {};
    for (const [k, v] of new URL(req.url).searchParams) initialGivens[k] = v;
    // Capability token for the sandboxed guest to fetch its own bundle without a
    // session cookie (see frame-token.ts). Scoped to this viewer + dashboard.
    const token = mintFrameToken({ userId: user.id, datasetId, name });
    const bundleUrl = `/api/dashboards/${datasetId}/${encodeURIComponent(name)}/bundle?t=${encodeURIComponent(token)}`;
    // __DASHBOARD__ mirrors the model's `# artifact` tag (the stored manifest
    // is synthesized from it at publish/refresh time).
    const info = {
      name: dash.name,
      query: dash.manifest.query,
      title: dash.title,
      description: dash.manifest.description,
      givens: dash.manifest.givens,
      autorun: dash.manifest.autorun,
    };
    const html =
      `<!doctype html><html><head><meta charset="utf-8"><title>${esc(dash.title)}</title>` +
      `<meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
      `<body style="margin:0"><div id="root"></div>` +
      `<script>window.__DASHBOARD__=${JSON.stringify(info)};` +
      `window.__GIVENS__=${JSON.stringify(givenSpecs)};` +
      `window.__INITIAL_GIVENS__=${JSON.stringify(initialGivens)}</script>` +
      `<script src="/dashboard-vendor.js"></script>` +
      `<script src="${bundleUrl}"></script></body></html>`;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  } catch (err) {
    if (err instanceof UnauthorizedError) return new Response("sign in required", { status: 401 });
    throw err;
  }
}
