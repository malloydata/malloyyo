// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * Dashboards in an MCP App panel.
 *
 * ONE generic panel resource serves every dashboard. The panel ships the frame
 * runtime and a loader; which dashboard to render arrives in the tool result,
 * and the compiled bundle is fetched at call time through an app-only tool and
 * `blob:`-imported. (Verified: a panel can import code delivered as a string,
 * no eval required.) src/app/mcp/route.ts registers all of it on the SDK.
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

import { bundleDashboard } from "@/lib/dashboards/bundle";
import { dashboardViewData } from "@/lib/dashboards/engine";
import { listDashboards } from "@/lib/dashboards";

export const SHOW_TOOL = "show_dashboard";

export const BUNDLE_TOOL = "dashboard_bundle";
export const RUN_TOOL = "dashboard_run";

export interface PanelRef {
  datasetId: string;
  name: string;
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
