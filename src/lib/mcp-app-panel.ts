// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * The MCP App panel document: a few hundred bytes of markup and a loader that
 * pull the frame runtime and the ext-apps SDK from this instance's own origin
 * (see mcp-app-dashboard.ts for what the panel then fetches).
 *
 * The scripts are REFERENCED, not inlined. Inlining them made `resources/read`
 * a ~5 MB JSON-RPC message — over Vercel's 4.5 MB function-response limit and
 * past what a host will accept — so the panel silently never loaded ("Unable to
 * reach <instance>" in the client, while the function logged a cheerful 200).
 * The ext spec expects exactly this shape: serve your bundle from your own
 * origin and declare that origin in the resource's `_meta.ui.csp.resourceDomains`,
 * which /mcp does. It also means the 4.6 MB runtime is fetched by URL and cached
 * by the browser rather than re-sent through the protocol per panel.
 *
 * Kept apart from mcp-app-dashboard.ts on purpose: this module touches no
 * database and no Malloy, so it can be built, cached, and tested on its own.
 */

import { createHash } from "node:crypto";

/** Built by scripts/build-dashboard-vendor.mjs, served from public/. */
const RUNTIME_SRC = "/dashboard-vendor.js";
const SDK_SRC = "/mcp-app-sdk.js";

/**
 * The loader. Written as a plain string with no interpolation of anything
 * dynamic — everything it needs arrives at runtime — so there are no escaping
 * layers to get wrong.
 */
const LOADER = String.raw`
const { App, applyDocumentTheme, applyHostStyleVariables, applyHostFonts } = globalThis.__EXT_APPS__;
const root = document.getElementById("root");
const app = new App({ name: "Malloyyo Dashboard", version: "1.0.0" });
app.onerror = console.error;
app.onteardown = async () => ({});

function fail(what, e) {
  root.innerHTML =
    "<pre style='white-space:pre-wrap;padding:12px;font:12px ui-monospace'>" +
    what + ": " + String((e && e.stack) || (e && e.message) || e) + "</pre>";
}

let started = false;
async function start(result) {
  if (started) return;
  const sc = (result && result.structuredContent) || {};
  if (!sc.datasetId || !sc.name) return;
  started = true;
  const ref = { datasetId: sc.datasetId, name: sc.name };

  // Queries go out through the host, as the connected user.
  window.__DASH_RUNTIME__.setHost({
    async run(req, givens) {
      try {
        const res = await app.callServerTool({
          name: "dashboard_run",
          arguments: {
            datasetId: ref.datasetId,
            name: ref.name,
            query: req.query,
            malloy: req.malloy,
            givens: givens || {},
          },
        });
        return (res && res.structuredContent) || { ok: false, error: "no result" };
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
      }
    },
    // A panel owns no URL and has no sibling frame to navigate to.
    navigate() {},
    syncGivens() {},
    syncUrlState() {},
  });

  let payload;
  try {
    const res = await app.callServerTool({ name: "dashboard_bundle", arguments: ref });
    payload = res && res.structuredContent;
    if (!payload || !payload.ok) throw new Error((payload && payload.error) || "bundle failed");
  } catch (e) {
    return fail("Could not load the dashboard", e);
  }

  window.__DASHBOARD__ = payload.info || {};
  window.__DASHBOARDS__ = payload.siblings || [];
  window.__GIVENS__ = payload.givenSpecs || [];
  // A panel has no query string; the frame's bootstrap reads one, so supply
  // the results it would have produced.
  window.__INITIAL_GIVENS__ = {};
  window.__INITIAL_URLSTATE__ = {};

  try {
    const js = new TextDecoder().decode(
      Uint8Array.from(atob(payload.js), (c) => c.charCodeAt(0)),
    );
    const url = URL.createObjectURL(new Blob([js], { type: "text/javascript" }));
    await import(url);
    URL.revokeObjectURL(url);
  } catch (e) {
    return fail("Could not run the dashboard", e);
  }
}

function applyHostContext(ctx) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles && ctx.styles.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles && ctx.styles.css && ctx.styles.css.fonts) applyHostFonts(ctx.styles.css.fonts);
}

app.ontoolresult = start;
app.onhostcontextchanged = applyHostContext;

app.connect().then(() => {
  applyHostContext(app.getHostContext());
  app.setupSizeChangedNotifications();
  const ctx = app.getHostContext();
  if (ctx && ctx.toolResult) start(ctx.toolResult);
});
`;

/**
 * The panel document and its content-addressed URI.
 *
 * The URI hashes the SHELL — markup, loader, and the origin its scripts come
 * from — so it changes when the shell changes and not when a dashboard does,
 * which is what lets a dashboard edit skip a client reconnect. The runtime
 * itself now sits behind a URL, so a runtime rebuild no longer moves the URI
 * either; the browser's own cache validators handle that.
 */
export interface DashboardPanel {
  html: string;
  uri: string;
}

const panelCache = new Map<string, DashboardPanel>();

/**
 * The panel for one origin, built once per process per origin (an instance
 * answers on one, but a preview deployment also answers on its generated URL).
 *
 * `origin` is where the panel's scripts are fetched from — the URL the client
 * reached /mcp at — and it must also be declared in the resource's
 * `_meta.ui.csp.resourceDomains`, or the sandboxed panel loads nothing.
 */
export function dashboardPanel(origin: string): DashboardPanel {
  const cached = panelCache.get(origin);
  if (cached) return cached;
  const html = buildPanelHtml(origin);
  const hash = createHash("sha256").update(html).digest("hex").slice(0, 12);
  const panel = { html, uri: `ui://dashboard/panel-${hash}.html` };
  panelCache.set(origin, panel);
  return panel;
}

function buildPanelHtml(origin: string): string {
  const base = origin.replace(/\/$/, "");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<title>Dashboard</title>
</head>
<body style="margin:0">
<div id="root"></div>
<script>
// A panel that fails silently is indistinguishable from one that never
// rendered — the most expensive failure mode in this whole surface. A script
// that 404s or is blocked by the panel's CSP reports itself here too.
window.addEventListener("error", function (e) {
  var r = document.getElementById("root");
  var what = e && e.target && e.target.src ? "Could not load " + e.target.src : String((e && e.message) || e);
  if (r && !r.childNodes.length) {
    r.innerHTML = "<pre style='white-space:pre-wrap;padding:12px;font:12px ui-monospace'>" + what + "</pre>";
  }
}, true);
</script>
<script src="${base}${SDK_SRC}"></script>
<script src="${base}${RUNTIME_SRC}"></script>
<script type="module">${LOADER}</script>
</body>
</html>
`;
}
