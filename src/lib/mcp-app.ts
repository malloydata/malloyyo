// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * PROTOTYPE — a Malloyyo dashboard rendered inline in the client, via the MCP
 * Apps extension (the same mechanism MotherDuck's `view_dive` uses).
 *
 * How the extension works, as observed from MotherDuck's shipped dive-viewer
 * bundle (their app-side SDK, protocol version 2026-01-26):
 *
 *   - The server publishes an HTML resource whose mimeType carries the
 *     `profile=mcp-app` parameter, plus a `_meta.ui` block declaring the CSP
 *     the sandbox should be given (connect/resource/frame domains).
 *   - A tool points at that resource with `_meta.ui.resourceUri`. When the
 *     model calls the tool, the host loads the resource into a sandboxed
 *     iframe instead of (only) printing the result.
 *   - Host and app speak JSON-RPC 2.0 over `postMessage`. The app opens with
 *     `ui/initialize`; the host answers with its capabilities and then pushes
 *     `ui/notifications/tool-result` carrying the ordinary CallToolResult.
 *     The app can push `ui/notifications/size-changed`, `ui/open-link`,
 *     `ui/update-model-context`, and more.
 *
 * What this prototype does with it: the wordfinder dashboards are already a
 * static, fully client-side site (DuckDB-WASM over a Parquet file, no server),
 * so the app is a thin frame that points an inner iframe at the published
 * dashboard URL with the givens the model chose encoded into the query string.
 * That is why `frameDomains` is the interesting part of the CSP here.
 *
 * Throwaway by design: one hard-coded site, no auth, no scoping to the
 * instance's own datasets.
 */

export const DASHBOARD_APP_URI = "ui://malloyyo/dashboard.html";

/** Where the built dashboards live. Wordfinder publishes to GitHub Pages. */
const SITE = process.env.DASHBOARD_APP_SITE ?? "https://lloydtabb.github.io/wordfinder";

const SITE_ORIGIN = new URL(SITE).origin;

/**
 * What a dashboard loads besides itself: DuckDB-WASM's worker and wasm come
 * from jsdelivr, and DuckDB pulls its `json` and `icu` extensions from
 * extensions.duckdb.org at startup. MotherDuck's dive viewer declares the same
 * extension host, for the same reason.
 *
 * Strictly, framing the dashboard puts it in its own browsing context with its
 * own (empty) CSP, so these are not consulted on that path — they are declared
 * so the CSP stays honest about what the app causes to load, and so the
 * inline-the-bundle variant works without another round of debugging.
 */
const DASHBOARD_CDNS = ["https://cdn.jsdelivr.net", "https://extensions.duckdb.org"];

/**
 * The dashboards this prototype knows about, and the one query-string key each
 * one's main input lives under.
 *
 * Two namespaces share that query string (packages/cli/src/shared/givens-url.ts):
 * `$NAME` is a GIVEN — the model-declared, MCP-visible query contract — and
 * `~key` is a custom component's view state. Which one the primary input uses
 * is per-dashboard: word-grep's regex is a given, the anagram rack is view
 * state the JS component owns.
 */
const DASHBOARDS = {
  anagram: {
    title: "Anagram",
    summary: "Every word you can spell from a set of letters (`?` is a blank).",
    inputKey: "~rack",
    inputLabel: "the letters to spell from, e.g. `retinas`",
  },
  "phrase-anagram": {
    title: "Phrase Anagram",
    summary: "Rearranges a whole phrase into other phrases using every letter once.",
    inputKey: "~phrase",
    inputLabel: "the phrase to rearrange, e.g. `dormitory`",
  },
  scrabble: {
    title: "Scrabble Cheat",
    summary: "Plays across a board row from your rack and the tiles already down.",
    inputKey: "~rack",
    inputLabel: "your rack, e.g. `aeinrst`",
  },
  "word-grep": {
    title: "Word Grep",
    summary: "Matches dictionary words against a regular expression.",
    inputKey: "$REGEX",
    inputLabel: "a regular expression, e.g. `^q[^u]`",
  },
} as const;

type DashboardName = keyof typeof DASHBOARDS;

const NAMES = Object.keys(DASHBOARDS) as DashboardName[];

function isDashboard(v: unknown): v is DashboardName {
  return typeof v === "string" && (NAMES as string[]).includes(v);
}

/** The resource descriptor for `resources/list`. */
export function dashboardAppResource() {
  return {
    uri: DASHBOARD_APP_URI,
    name: "Malloyyo Dashboard",
    description: "Renders a Malloyyo dashboard inline.",
    mimeType: "text/html;profile=mcp-app",
    _meta: {
      ui: {
        // The dashboard runs at its published origin inside a nested iframe,
        // so frameDomains is what has to be open. connect/resource are listed
        // too for the variant that inlines the bundle instead of framing it.
        csp: {
          frameDomains: [SITE_ORIGIN],
          connectDomains: [SITE_ORIGIN, ...DASHBOARD_CDNS],
          resourceDomains: [SITE_ORIGIN, ...DASHBOARD_CDNS],
        },
        prefersBorder: false,
      },
    },
  };
}

/** The tool descriptor, bound to the resource above via `_meta.ui.resourceUri`. */
export function dashboardAppTool(tag: string) {
  return {
    name: "show_dashboard",
    title: "Show a dashboard",
    description:
      `${tag} EXPERIMENTAL. Renders one of the Word Finder dashboards inline, as an ` +
      `interactive app the user can then drive themselves. Dashboards: ` +
      NAMES.map((n) => `\`${n}\` — ${DASHBOARDS[n].summary}`).join(" ") +
      ` Pass \`input\` to open it on a specific question; the user can change ` +
      `anything from there. Every search runs in their browser over a Parquet ` +
      `dictionary, so nothing here queries this instance's datasets.`,
    inputSchema: {
      type: "object",
      properties: {
        dashboard: {
          type: "string",
          enum: NAMES,
          description: "Which dashboard to open.",
        },
        input: {
          type: "string",
          description:
            "The dashboard's main input: letters for `anagram` and `scrabble`, " +
            "a phrase for `phrase-anagram`, a regex for `word-grep`.",
        },
        dictionary: {
          type: "string",
          enum: ["common", "popular", "enable", "twl", "collins", "all"],
          description:
            "Word list to search. `enable` (the default) is the open word-game " +
            "standard; `common` is the 8k most frequent words, `all` is everything.",
        },
        params: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            "Escape hatch: extra query-string keys, `$NAME` for a given and " +
            "`~name` for view state.",
        },
      },
      required: ["dashboard"],
    },
    _meta: { ui: { resourceUri: DASHBOARD_APP_URI } },
  };
}

export function isDashboardAppTool(name: string) {
  return name === "show_dashboard";
}

/**
 * Build the CallToolResult. `structuredContent` is what the app reads off
 * `ui/notifications/tool-result`; the text block is what the model sees, and it
 * matters that the model does NOT then narrate the answer — the point of the
 * app is that the user reads it off the rendered dashboard.
 */
export function callDashboardApp(args: Record<string, unknown>) {
  const name = args.dashboard;
  if (!isDashboard(name)) {
    throw new Error(`unknown dashboard "${String(args.dashboard)}" — try one of: ${NAMES.join(", ")}`);
  }
  const spec = DASHBOARDS[name];

  const params = new URLSearchParams();
  const input = typeof args.input === "string" ? args.input.trim() : "";
  if (input) params.set(spec.inputKey, input);
  if (typeof args.dictionary === "string" && args.dictionary) params.set("$DICT", args.dictionary);
  const extra = args.params;
  if (extra && typeof extra === "object") {
    for (const [k, v] of Object.entries(extra as Record<string, unknown>)) {
      if (v == null) continue;
      // Keep both namespaces addressable, and default a bare key to a given.
      params.set(k.charAt(0) === "$" || k.charAt(0) === "~" ? k : "$" + k, String(v));
    }
  }

  const qs = params.toString();
  const url = `${SITE}/${name}.html${qs ? "?" + qs : ""}`;

  return {
    content: [
      {
        type: "text",
        text:
          `Opened the ${spec.title} dashboard${input ? ` on "${input}"` : ""}. ` +
          `It is rendered above and the user can change the inputs themselves — ` +
          `tell them it is there rather than restating results you cannot see.`,
      },
    ],
    structuredContent: { url, dashboard: name, title: spec.title, input: input || null },
  };
}

/**
 * The app itself. Hand-rolled against the wire protocol rather than pulled from
 * an SDK — it is ~60 lines of JSON-RPC over postMessage and this is a
 * prototype.
 */
export function dashboardAppHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Malloyyo dashboard</title>
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  #frame { display: block; width: 100%; height: 620px; border: 0; }
  #status {
    font: 13px/1.5 ui-sans-serif, system-ui, sans-serif;
    color: #6a6a6a; padding: 24px;
  }
  #status[hidden] { display: none !important; }
</style>
</head>
<body>
<div id="status">Loading dashboard…</div>
<iframe id="frame" hidden title="Malloyyo dashboard"
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms"></iframe>
<script>
(function () {
  var PROTOCOL_VERSION = "2026-01-26";
  var FALLBACK = ${JSON.stringify(`${SITE}/anagram.html`)};

  var nextId = 0;
  var pending = {};
  var loaded = false;

  function send(msg) { parent.postMessage(msg, "*"); }
  function notify(method, params) { send({ jsonrpc: "2.0", method: method, params: params || {} }); }
  function request(method, params) {
    var id = ++nextId;
    send({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
    return new Promise(function (resolve) { pending[id] = resolve; });
  }

  function show(url) {
    if (loaded || !url) return;
    loaded = true;
    var frame = document.getElementById("frame");
    frame.src = url;
    frame.hidden = false;
    document.getElementById("status").hidden = true;
    // The host sizes the panel from this, not from the iframe's own content:
    // the inner document is cross-origin, so its height is not observable.
    notify("ui/notifications/size-changed", { height: 620 });
  }

  // A tool result can arrive as a notification after the handshake, or be
  // waiting in hostContext.toolInfo when we connect. Take it from either.
  function fromResult(result) {
    var sc = result && result.structuredContent;
    return sc && typeof sc.url === "string" ? sc.url : null;
  }

  window.addEventListener("message", function (event) {
    var msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0") return;
    if (msg.id != null && pending[msg.id]) {
      var resolve = pending[msg.id];
      delete pending[msg.id];
      resolve(msg.result);
      return;
    }
    if (msg.method === "ui/notifications/tool-result") show(fromResult(msg.params));
  });

  request("ui/initialize", {
    protocolVersion: PROTOCOL_VERSION,
    appInfo: { name: "malloyyo-dashboard", version: "0.1.0" },
    appCapabilities: {}
  }).then(function (result) {
    var ctx = result && result.hostContext;
    if (ctx && ctx.toolResult) show(fromResult(ctx.toolResult));
    // If nothing arrived, open the default dashboard rather than sitting on a
    // spinner — a prototype that renders something is easier to debug than one
    // that renders nothing.
    setTimeout(function () { show(FALLBACK); }, 2000);
  });
})();
</script>
</body>
</html>
`;
}
