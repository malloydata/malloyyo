// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * The MCP App panel document: the ext-apps SDK, the frame runtime, and a
 * loader, inlined into one HTML resource that is identical for every
 * dashboard (see mcp-app-dashboard.ts for what the panel then fetches).
 *
 * Kept apart from mcp-app-dashboard.ts on purpose: this module reads two files
 * and nothing else — no database, no Malloy — so it can be built, cached, and
 * tested on its own.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { logger } from "@/lib/logger";

let vendorCache: string | null = null;
function vendor(): string {
  if (vendorCache === null) {
    vendorCache = fs.readFileSync(path.join(process.cwd(), "public/dashboard-vendor.js"), "utf8");
  }
  return vendorCache;
}

let sdkCache: string | null = null;
/** The ext-apps bundle, its minified export list rewritten onto a global. */
function sdk(): string {
  if (sdkCache === null) {
    const raw = fs.readFileSync(
      path.join(process.cwd(), "node_modules/@modelcontextprotocol/ext-apps/dist/src/app-with-deps.js"),
      "utf8",
    );
    const m = /export\s*\{([^}]*)\}\s*;?\s*$/.exec(raw);
    if (!m) throw new Error("ext-apps bundle: no export statement found");
    const globals = m[1]
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => {
        const [local, , exported] = x.split(/\s+/);
        return `${JSON.stringify(exported ?? local)}: ${local}`;
      })
      .join(", ");
    sdkCache = raw.slice(0, m.index) + `globalThis.__EXT_APPS__ = {${globals}};`;
  }
  return sdkCache;
}

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

/** The panel document and its content-addressed URI. Identical for every
    dashboard. The URI hashes the RUNTIME, so it changes when the shell changes
    and not when a dashboard does — which is what lets a dashboard edit skip a
    client reconnect. */
export interface DashboardPanel {
  html: string;
  uri: string;
}

let panelCache: DashboardPanel | null = null;
let panelFailed = false;

/**
 * The panel, built once per process — both inputs are files read once, and
 * /mcp builds a server per request — or null when those files can't be read.
 *
 * Null rather than a throw so a missing or unreadable asset (a build that
 * skipped `public/dashboard-vendor.js`, a tracing miss) costs only the
 * dashboard tools: /mcp keeps serving list_sources, describe_source and query.
 * The failure is logged once and remembered; the files won't appear later in
 * the same deployment.
 */
export function dashboardPanel(): DashboardPanel | null {
  if (panelCache) return panelCache;
  if (panelFailed) return null;
  try {
    const html = buildPanelHtml();
    const hash = createHash("sha256").update(html).digest("hex").slice(0, 12);
    panelCache = { html, uri: `ui://dashboard/panel-${hash}.html` };
    return panelCache;
  } catch (e) {
    panelFailed = true;
    logger.error("mcp dashboard panel unavailable — dashboard tools disabled", {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

function buildPanelHtml(): string {
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
// rendered — the most expensive failure mode in this whole surface.
window.addEventListener("error", function (e) {
  var r = document.getElementById("root");
  if (r && !r.childNodes.length) {
    r.innerHTML = "<pre style='white-space:pre-wrap;padding:12px;font:12px ui-monospace'>" +
      String((e && e.message) || e) + "</pre>";
  }
});
</script>
<script type="module">${sdk()}</script>
<script>${vendor()}</script>
<script type="module">${LOADER}</script>
</body>
</html>
`;
}
