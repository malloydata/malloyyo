// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * PROTOTYPE — a Malloy query result rendered as a table inside an MCP App.
 *
 * Deliberately small. An earlier version framed the published wordfinder site
 * in a nested iframe, which made the panel depend on an external origin and
 * needed CSP exceptions no reference app requires. This one serves everything
 * literally from the `ui://` resource, the way every shipped example does:
 * the app is self-contained HTML and renders the rows it is handed.
 *
 * The tool itself is a thin wrapper over the instance's existing `query` tool,
 * so the data is real and there is exactly one query path to maintain. The
 * only thing this adds is `_meta.ui.resourceUri`, which is what makes a host
 * render the result instead of printing it.
 */

import { REFERENCE_APP_HTML } from "./mcp-app-ref/reference-app";
import { APP_HTML } from "./mcp-app-src/generated-app-html";

/**
 * Serve the reference app verbatim instead of ours. A control switch: it
 * separates "our server declares the app wrongly" from "our HTML is wrong",
 * which no amount of reading either one has settled.
 */
const SERVE_REFERENCE_APP = process.env.MCP_APP_REFERENCE === "1";

export const DASHBOARD_APP_URI = "ui://show_dashboard/mcp-app-v3.html";

/**
 * Every URI this app has EVER been advertised under.
 *
 * Clients cache resources/list and do not re-read it — not on reconnect, not
 * on a fresh grant. A client that first saw this server during the hello-world
 * build still asks for ui://malloyyo/hello.html, gets "resource not found",
 * and reports "there was a problem displaying content". Renaming the URI to
 * match the SDK examples' convention is what broke those clients.
 *
 * So serve the app under all of them. A stale URI costs one map entry; a
 * client that can never resolve the resource costs the whole feature.
 */
const LEGACY_APP_URIS = [
  "ui://show_dashboard/mcp-app-v2.html",
  "ui://show_dashboard/mcp-app.html",
  "ui://malloyyo/hello.html",
  "ui://malloyyo/dashboard.html",
];

export function isAppResourceUri(uri: string): boolean {
  return uri === DASHBOARD_APP_URI || LEGACY_APP_URIS.includes(uri);
}

/** List the current URI first, then the legacy ones, so new clients take the current. */
export function appResourceUris(): string[] {
  return [DASHBOARD_APP_URI, ...LEGACY_APP_URIS];
}

export const UI_EXTENSION_ID = "io.modelcontextprotocol/ui";

export const APP_MIME_TYPE = "text/html;profile=mcp-app";

/** The tool whose result this app renders. */
export const BACKING_TOOL = "query";

export function dashboardAppResources() {
  return appResourceUris().map((uri) => ({
    uri,
    name: uri,
    mimeType: APP_MIME_TYPE,
  }));
}

export function dashboardAppResourceContents(uri: string = DASHBOARD_APP_URI) {
  return {
    uri,
    mimeType: APP_MIME_TYPE,
    text: SERVE_REFERENCE_APP ? REFERENCE_APP_HTML : dashboardAppHtml(),
  };
}

export const DASHBOARD_SOURCE = "baby_names";

export const DASHBOARD_QUESTION = "Top 10 boys' and girls' names by decade";

export const DASHBOARD_MALLOY = `run: baby_names -> births_by_decade + {
  # list
  nest: male_names is {
    where: gender = 'M'
    group_by: name
    aggregate: total_babies
    limit: 10
  }
  # list
  nest: female_names is {
    where: gender = 'F'
    group_by: name
    aggregate: total_babies
    limit: 10
  }
  order_by: decade desc
}`;

/** No parameters: one fixed query, rendered as a panel. */
export function dashboardAppTool(tag: string) {
  return {
    name: "show_dashboard",
    title: "Baby names by decade",
    description:
      `${tag} Renders a dashboard of the top 10 boys' and girls' names for ` +
      `each decade, as an inline panel. Takes no arguments. Once it renders, ` +
      `say it is there rather than restating the names.`,
    annotations: { title: "Baby names by decade", readOnlyHint: true },
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: {}, additionalProperties: true },
    _meta: {
      ui: { resourceUri: DASHBOARD_APP_URI },
      "ui/resourceUri": DASHBOARD_APP_URI,
    },
  };
}

/**
 * A small fixed result, shaped exactly like the query surface's payload.
 *
 * The real Malloy query is correct but costs 13-99s through /mcp (the same
 * query runs in 3.4s through /api/run — a separate performance problem in the
 * explore surface, not in this app). Rendering a panel and diagnosing that are
 * two different jobs; this keeps the panel instant so the App path can be
 * finished and demonstrated, and the query swapped back in once it is fast.
 */
export function staticDashboardResult() {
  const rows = [
    {
      decade: 2020,
      total_babies: 5_594_855,
      male_names: [
        { name: "Liam", total_babies: 40_049 },
        { name: "Noah", total_babies: 37_103 },
        { name: "Oliver", total_babies: 28_850 },
        { name: "Elijah", total_babies: 25_844 },
        { name: "James", total_babies: 24_710 },
      ],
      female_names: [
        { name: "Olivia", total_babies: 35_369 },
        { name: "Emma", total_babies: 31_089 },
        { name: "Charlotte", total_babies: 26_350 },
        { name: "Ava", total_babies: 25_919 },
        { name: "Amelia", total_babies: 25_719 },
      ],
    },
    {
      decade: 2010,
      total_babies: 30_624_624,
      male_names: [
        { name: "Noah", total_babies: 183_076 },
        { name: "Liam", total_babies: 173_797 },
        { name: "Jacob", total_babies: 163_027 },
        { name: "William", total_babies: 159_773 },
        { name: "Mason", total_babies: 157_718 },
      ],
      female_names: [
        { name: "Emma", total_babies: 194_836 },
        { name: "Olivia", total_babies: 184_355 },
        { name: "Sophia", total_babies: 180_953 },
        { name: "Isabella", total_babies: 170_337 },
        { name: "Ava", total_babies: 155_690 },
      ],
    },
    {
      decade: 2000,
      total_babies: 33_079_414,
      male_names: [
        { name: "Jacob", total_babies: 273_945 },
        { name: "Michael", total_babies: 250_633 },
        { name: "Joshua", total_babies: 231_983 },
        { name: "Matthew", total_babies: 221_573 },
        { name: "Daniel", total_babies: 203_832 },
      ],
      female_names: [
        { name: "Emily", total_babies: 223_723 },
        { name: "Madison", total_babies: 193_181 },
        { name: "Emma", total_babies: 181_333 },
        { name: "Olivia", total_babies: 156_030 },
        { name: "Hannah", total_babies: 155_732 },
      ],
    },
  ];
  return {
    content: [{ type: "text", text: `Rendered ${rows.length} decades of top baby names.` }],
    structuredContent: { ok: true, rows, row_count: rows.length },
  };
}

/** The fixed arguments handed to the instance's own `query` tool. */
export function dashboardQueryArgs() {
  return {
    source: DASHBOARD_SOURCE,
    malloy: DASHBOARD_MALLOY,
    question: DASHBOARD_QUESTION,
  };
}

export function isDashboardAppTool(name: string) {
  return name === "show_dashboard";
}

/**
 * The app: self-contained, no iframe, no network. It finds the first array of
 * objects anywhere in the tool result and renders it as a table, rather than
 * hard-coding a shape — the query surface's payload can change without this
 * needing to know.
 */
/**
 * The app page: the official ext-apps SDK bundle inlined, plus our renderer.
 * Generated by scripts/build-mcp-app.mjs from src/lib/mcp-app-src/app.js —
 * rebuild after editing that file.
 *
 * Hand-rolling the postMessage handshake is what made this so hard to land:
 * the SDK owns the initialize exchange, the one-shot tool-result delivery,
 * teardown, size reporting and host theming. Our code now only renders rows.
 */
export function dashboardAppHtml(): string {
  return APP_HTML;
}
