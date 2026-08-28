// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The sandboxed-iframe document for a dashboard: inlines the manifest and loads
// the bundled artifact. The iframe runs with sandbox="allow-scripts" (opaque
// origin, no session cookie), so this route — reached by the cookie-authed
// subframe navigation — mints a short-lived capability token and hands it to the
// bundle URL so the guest can load its own compiled code without a cookie.
// A separate artifact origin is the remaining hardening (docs/repo-artifacts.md
// §8, docs/dashboard-iframe-security.md).
//
// This document inlines model-derived data into a <script> block, so it is an
// XSS sink by construction: build it ONLY through @/lib/dashboards/frame-html,
// which escapes the payloads and sends the CSP (including `sandbox`, so the
// containment no longer depends on the embedder). Request-derived data — the
// `?$given=…` / `?~viewstate=…` link state — is NOT inlined at all; the frame
// reads it from its own location.search. Keep it that way.

import { getSessionUser, UnauthorizedError } from "@/lib/user";
import { dashboardViewData } from "@/lib/dashboards/engine";
import { mintFrameToken } from "@/lib/dashboards/frame-token";
import { frameCsp, frameHtml, frameNonce } from "@/lib/dashboards/frame-html";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ datasetId: string; name: string }> }) {
  try {
    const user = await getSessionUser();
    const { datasetId, name } = await ctx.params;
    // info + given specs are assembled by the shared helper, so this sandboxed
    // path and the in-page tag-only renderer stay in lockstep.
    const view = await dashboardViewData(user.id, datasetId, name);
    if (!view) return new Response("dashboard not found", { status: 404 });
    const { dash, info, givenSpecs, imageHosts } = view;
    // The shareable-link state (`?$given=…`, `?~viewstate=…`) is deliberately
    // NOT read here. It is already on this document's own URL, so the frame
    // parses location.search itself (frame-html.ts: FRAME_BOOTSTRAP) and the
    // request never becomes part of the response body. Reflecting it was the
    // reflected-XSS surface; not reflecting it is the fix.
    //
    // Capability token for the sandboxed guest to fetch its own bundle without a
    // session cookie (see frame-token.ts). Scoped to this viewer + dashboard.
    const token = mintFrameToken({ userId: user.id, datasetId, name });
    const bundleUrl = `/api/dashboards/${datasetId}/${encodeURIComponent(name)}/bundle?t=${encodeURIComponent(token)}`;
    // Escaping and the CSP live in frame-html.ts — read the header there before
    // adding anything to this document. JSON.stringify alone is NOT safe in a
    // script element, and only model-derived values belong in there at all.
    const nonce = frameNonce();
    const html = frameHtml({ title: dash.title, info, givenSpecs, bundleUrl, nonce });
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        // The sandbox is enforced by THIS response, not only by whoever embeds
        // it: the route is reachable as a top-level navigation (proxy.ts:29
        // passes /api/ straight through), where no iframe attribute applies.
        // img-src is widened only by hosts the repo named in malloy-config.json;
        // frameCsp re-validates them, since this is where they enter a header.
        "content-security-policy": frameCsp(nonce, imageHosts),
        // No Referrer-Policy here on purpose. An allowed image host could
        // otherwise learn the dashboard URL and its ?$given=… state from the
        // Referer of every image it serves — but next.config.ts already sends
        // `strict-origin-when-cross-origin` for every path, which strips path
        // and query cross-origin, and this document's origin is opaque
        // (sandbox), so browsers send no Referer from it at all. A header set
        // here would also be overridden by the config's, so it would read as
        // protection while doing nothing.
        "x-content-type-options": "nosniff",
      },
    });
  } catch (err) {
    if (err instanceof UnauthorizedError) return new Response("sign in required", { status: 401 });
    throw err;
  }
}
