// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * Dashboards in an MCP App panel.
 *
 * ONE generic panel resource serves every dashboard. The panel ships the frame
 * runtime and a loader; which dashboard to render arrives in the tool result,
 * and the compiled bundle is fetched at call time through an app-only tool and
 * `blob:`-imported. (Verified: a panel can import code delivered as a string,
 * no eval required — see prototype/stage0.)
 *
 * That shape is what makes this scale:
 *
 *   - three tools regardless of dashboard count, not one tool per dashboard;
 *   - the 4.4 MB runtime is fetched once per client and cached across every
 *     dashboard, because the URI hashes the RUNTIME, not the dashboard;
 *   - editing a dashboard needs no client reconnect, because its bundle is not
 *     part of the resource. That removes the restart-per-iteration tax that
 *     `_meta.ui.resourceUri` living in a cached tools/list otherwise imposes.
 *
 * The panel IS the frame — no nested iframe. The only frame-specific work is
 * installing a third runtime HOST whose `run` calls `app.callServerTool`, so
 * queries are proxied by the host as the connected user: no CORS, and no
 * credentials in the panel.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { bundleDashboard } from "@/lib/dashboards/bundle";
import { dashboardViewData } from "@/lib/dashboards/engine";
import { listDashboards } from "@/lib/dashboards";

export const SHOW_TOOL = "show_dashboard";

/**
 * A stamp the client cannot fake. Tool definitions are cached hard and never
 * re-read, so "is my client's copy current?" has been unanswerable all along —
 * and several rounds were lost to guessing. Printing it in the description
 * makes staleness visible at a glance instead of inferable from behaviour.
 */
export const SURFACE_BUILD = new Date().toISOString().slice(11, 19) + "Z";
export const BUNDLE_TOOL = "dashboard_bundle";
export const RUN_TOOL = "dashboard_run";

export interface PanelRef {
  datasetId: string;
  name: string;
}

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

/** The panel document. Identical for every dashboard. */
export function panelHtml(): string {
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

/** Hashes the RUNTIME, so it changes when the shell changes and not when a
    dashboard does — which is what lets a dashboard edit skip a reconnect. */
export function panelUri(): string {
  const hash = createHash("sha256").update(panelHtml()).digest("hex").slice(0, 12);
  return `ui://dashboard/panel-${hash}.html`;
}

export function isPanelUri(uri: string): boolean {
  return /^ui:\/\/dashboard\/panel-[0-9a-f]{6,}\.html$/.test(uri);
}

export type BundlePayload =
  | {
      ok: true;
      js: string;
      info: Record<string, unknown>;
      givenSpecs: unknown[];
      siblings: { name: string; title: string }[];
      title: string;
    }
  | { ok: false; error: string };

/**
 * Everything the panel needs to render one dashboard. `js` is base64 — it
 * travels as JSON through two hops, and base64 removes every escaping question
 * at once (three separate bugs during this work came from hand-escaping code
 * into markup).
 */
export async function dashboardBundlePayload(
  userId: string,
  ref: PanelRef,
): Promise<BundlePayload> {
  const view = await dashboardViewData(userId, ref.datasetId, ref.name);
  if (!view) return { ok: false, error: `dashboard '${ref.name}' not found in '${ref.datasetId}'` };

  const js = await bundleDashboard(view.dash.source ?? "");
  const siblings = (await listDashboards(userId, ref.datasetId))
    .filter((d) => d.name !== ref.name)
    .map((d) => ({ name: d.name, title: d.title }));

  return {
    ok: true,
    js: Buffer.from(js, "utf8").toString("base64"),
    info: view.info,
    givenSpecs: view.givenSpecs,
    siblings,
    title: String(view.dash.title ?? ref.name),
  };
}
