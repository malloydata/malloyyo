// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * PROTOTYPE — a Word Finder dashboard rendered inline as an MCP App.
 *
 * The wordfinder dashboards are already a static, fully client-side site
 * (DuckDB-WASM over a Parquet dictionary, no server), so this app is a thin
 * frame that points an inner iframe at the published dashboard with the givens
 * the model chose encoded into the query string — the same `$given` / `~state`
 * convention as a shareable link (packages/cli/src/shared/givens-url.ts).
 *
 * Wire format matches @modelcontextprotocol/ext-apps@2.0.0 (SEP-1865):
 *   - resource mimeType "text/html;profile=mcp-app" and nothing else: the
 *     shipped examples register with `{ mimeType }` alone, no `_meta.ui`;
 *   - the tool binds it with `_meta.ui.resourceUri` AND the legacy flat
 *     `_meta["ui/resourceUri"]`, because hosts must check both;
 *   - the host loads the HTML into a sandboxed iframe and speaks JSON-RPC over
 *     postMessage: the app sends `ui/initialize`, the host answers, then pushes
 *     `ui/notifications/tool-result` carrying the ordinary CallToolResult.
 *
 * Two hard-won details, kept deliberately:
 *   - <body> ships with STATIC content that the script replaces. An empty body
 *     made "panel rendered, script blocked" indistinguishable from "no panel",
 *     which cost several rounds of debugging.
 *   - `resultType` on the result envelope is stamped centrally in the route's
 *     ok() helper — required by protocol revision 2026-07-28 for every result,
 *     not just this tool's.
 */

/**
 * `ui://<tool-name>/mcp-app.html` — the convention every shipped example
 * follows (get-time → ui://get-time/mcp-app.html, debug-tool →
 * ui://debug-tool/mcp-app.html). Ours was ui://malloyyo/dashboard.html, which
 * ties to nothing a host could correlate with the tool.
 */
export const DASHBOARD_APP_URI = "ui://show_dashboard/mcp-app.html";

export const UI_EXTENSION_ID = "io.modelcontextprotocol/ui";

export const APP_MIME_TYPE = "text/html;profile=mcp-app";

/** Where the built dashboards live. Wordfinder publishes to GitHub Pages. */
const SITE = process.env.DASHBOARD_APP_SITE ?? "https://lloydtabb.github.io/wordfinder";

const SITE_ORIGIN = new URL(SITE).origin;

/**
 * DuckDB-WASM fetches its worker and wasm from jsdelivr, then pulls the `json`
 * and `icu` extensions from extensions.duckdb.org at startup. MotherDuck's dive
 * viewer declares the same extension host for the same reason.
 */
const DASHBOARD_CDNS = ["https://cdn.jsdelivr.net", "https://extensions.duckdb.org"];

/**
 * The dashboards, and the query-string key each one's primary input uses.
 *
 * Which namespace that key lives in is per-dashboard: word-grep's regex is a
 * declared `$REGEX` given, while the anagram rack is `~rack` view state owned by
 * a JS component. Both round-trip through the same shareable-link encoder.
 */
const DASHBOARDS = {
  anagram: {
    title: "Anagram",
    summary: "Every word you can spell from a set of letters (`?` is a blank).",
    inputKey: "~rack",
    inputHint: "letters to spell from, e.g. `retinas`",
  },
  "phrase-anagram": {
    title: "Phrase Anagram",
    summary: "Rearranges a whole phrase into other phrases using every letter once.",
    inputKey: "~phrase",
    inputHint: "a phrase to rearrange, e.g. `dormitory`",
  },
  scrabble: {
    title: "Scrabble Cheat",
    summary: "Plays across a board row from your rack and the tiles already down.",
    inputKey: "~rack",
    inputHint: "your rack, e.g. `aeinrst`",
  },
  "word-grep": {
    title: "Word Grep",
    summary: "Matches dictionary words against a regular expression.",
    inputKey: "$REGEX",
    inputHint: "a regular expression, e.g. `^q[^u]`",
  },
} as const;

type DashboardName = keyof typeof DASHBOARDS;

const NAMES = Object.keys(DASHBOARDS) as DashboardName[];

/** Exact `$DICT` values from the model's `in_dict` pick-chain. */
const DICTIONARIES = ["top10k", "common", "enable", "twl", "collins", "all"] as const;

function isDashboard(v: unknown): v is DashboardName {
  return typeof v === "string" && (NAMES as string[]).includes(v);
}

export function dashboardAppResource() {
  return {
    uri: DASHBOARD_APP_URI,
    name: DASHBOARD_APP_URI,
    mimeType: APP_MIME_TYPE,
    // The reference apps carry no `_meta.ui` because they render their own
    // content. This one nests an iframe, and `frameDomains` maps to CSP
    // frame-src where "empty or omitted" means NO nested iframes at all — so
    // stripping this block to match the reference is what blocks the frame.
    //
    // Serving the dashboard literally would remove the need for any of this,
    // and is the better shape; it is ~6.9MB of Malloy/DuckDB runtime to inline,
    // which is a change worth making once rendering is confirmed.
    _meta: {
      ui: {
        frameDomains: [SITE_ORIGIN],
        csp: {
          frameDomains: [SITE_ORIGIN],
          connectDomains: [SITE_ORIGIN, ...DASHBOARD_CDNS],
          resourceDomains: [SITE_ORIGIN, ...DASHBOARD_CDNS],
        },
      },
    },
  };
}

export function dashboardAppResourceContents() {
  return {
    uri: DASHBOARD_APP_URI,
    mimeType: APP_MIME_TYPE,
    text: dashboardAppHtml(),
  };
}

export function dashboardAppTool(tag: string) {
  return {
    name: "show_dashboard",
    title: "Show a Word Finder dashboard",
    description:
      `${tag} Renders one of the Word Finder dashboards inline, as an interactive ` +
      `panel the user can then drive themselves. Dashboards: ` +
      NAMES.map((n) => `\`${n}\` — ${DASHBOARDS[n].summary}`).join(" ") +
      ` Pass \`input\` to open it on a specific question; the user can change ` +
      `anything from there. Every search runs in their browser over a Parquet ` +
      `dictionary, so this queries no dataset on this instance. Once it renders, ` +
      `tell the user it is there rather than restating results you cannot see.`,
    // Directory submission requires a title plus one of these hints on every
    // tool. Nothing here writes: the dashboard is a view over a static file.
    annotations: { title: "Show a Word Finder dashboard", readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        dashboard: { type: "string", enum: NAMES, description: "Which dashboard to open." },
        input: {
          type: "string",
          description:
            "The dashboard's main input: " +
            NAMES.map((n) => `${n} → ${DASHBOARDS[n].inputHint}`).join("; ") + ".",
        },
        dictionary: {
          type: "string",
          enum: DICTIONARIES,
          description:
            "Word list to search. `enable` (default) is the open word-game standard; " +
            "`top10k` is the 8k most frequent words, `all` is everything (451k).",
        },
        params: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Escape hatch: extra query keys, `$NAME` given or `~name` view state.",
        },
      },
      required: ["dashboard"],
    },
    // The shipped examples all declare one, and this tool returns
    // structuredContent — which a strict client may reject as unschema'd
    // output when the tool never said it produces any.
    outputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The dashboard URL, givens encoded." },
        dashboard: { type: "string", description: "Which dashboard was opened." },
        title: { type: "string", description: "Its display name." },
        input: { type: ["string", "null"], description: "The primary input, if one was given." },
      },
      required: ["url", "dashboard", "title"],
    },
    _meta: {
      ui: { resourceUri: DASHBOARD_APP_URI },
      "ui/resourceUri": DASHBOARD_APP_URI,
    },
  };
}

export function isDashboardAppTool(name: string) {
  return name === "show_dashboard";
}

export function callDashboardApp(args: Record<string, unknown>) {
  const name = args.dashboard;
  if (!isDashboard(name)) {
    throw new Error(
      `unknown dashboard "${String(args.dashboard)}" — try one of: ${NAMES.join(", ")}`,
    );
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
      // Keep both namespaces addressable; a bare key defaults to a given.
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
          `It is rendered above and the user can change the inputs themselves.`,
      },
    ],
    structuredContent: { url, dashboard: name, title: spec.title, input: input || null },
  };
}

/**
 * The app. Hand-rolled against the wire protocol rather than pulled from the
 * SDK — it is ~70 lines of JSON-RPC over postMessage, and this is a prototype.
 */
export function dashboardAppHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Word Finder</title>
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  #frame { display: block; width: 100%; height: 640px; border: 0; }
  #status { font: 13px/1.6 ui-sans-serif, system-ui, sans-serif; color: #6a6a6a; padding: 20px; }
  #status[hidden] { display: none !important; }
  code { font-family: ui-monospace, monospace; }
</style>
</head>
<body>
<div id="status">
  Loading the dashboard&hellip;
  <div style="margin-top:6px">
    If this line is still here after a few seconds, the panel rendered but its
    JavaScript did not run.
  </div>
</div>
<iframe id="frame" hidden title="Word Finder dashboard"
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms"></iframe>
<script>
(function () {
  var PROTOCOL_VERSION = "2026-01-26";
  var pending = {};
  var nextId = 0;
  var loaded = false;

  function status(html) {
    var el = document.getElementById("status");
    el.hidden = false;
    el.innerHTML = html;
  }

  // Report height IMMEDIATELY and on every change, the way the SDK's
  // setupSizeChangedNotifications() does. Previously this fired only after a
  // tool result arrived — so if that notification never landed, the frame kept
  // a zero height and a perfectly rendered panel was invisible, which looks
  // exactly like "nothing rendered".
  var lastH = 0;
  function reportSize(h) {
    var height = h || Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0,
      120
    );
    if (height === lastH) return;
    lastH = height;
    parent.postMessage({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { width: Math.ceil(window.innerWidth), height: height }
    }, "*");
  }

  function show(url) {
    if (loaded || !url) return;
    loaded = true;
    var frame = document.getElementById("frame");
    frame.src = url;
    frame.hidden = false;
    document.getElementById("status").hidden = true;
    // The inner document is cross-origin, so its height is not observable
    // from here — name the frame's own fixed height instead.
    reportSize(660);
  }

  function urlFrom(result) {
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
    if (msg.method === "ui/notifications/tool-result") show(urlFrom(msg.params));
  });

  reportSize();
  if (typeof ResizeObserver === "function") {
    var ro = new ResizeObserver(function () { if (!loaded) reportSize(); });
    ro.observe(document.documentElement);
    if (document.body) ro.observe(document.body);
  }

  var id = ++nextId;
  parent.postMessage({
    jsonrpc: "2.0", id: id, method: "ui/initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      appInfo: { name: "malloyyo-wordfinder", version: "0.1.0" },
      appCapabilities: {}
    }
  }, "*");
  pending[id] = function (result) {
    // A tool result may already be waiting in hostContext rather than arriving
    // as a notification; take it from either.
    var ctx = result && result.hostContext;
    if (ctx && ctx.toolResult) show(urlFrom(ctx.toolResult));
    setTimeout(function () {
      if (!loaded) {
        status("Connected to the host, but no dashboard was named in the tool result.");
      }
    }, 3000);
  };
})();
</script>
</html>
`;
}
