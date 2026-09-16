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

export const DASHBOARD_APP_URI = "ui://show_dashboard/mcp-app.html";

export const UI_EXTENSION_ID = "io.modelcontextprotocol/ui";

export const APP_MIME_TYPE = "text/html;profile=mcp-app";

/** The tool whose result this app renders. */
export const BACKING_TOOL = "query";

export function dashboardAppResource() {
  return {
    uri: DASHBOARD_APP_URI,
    name: DASHBOARD_APP_URI,
    mimeType: APP_MIME_TYPE,
  };
}

export function dashboardAppResourceContents() {
  return {
    uri: DASHBOARD_APP_URI,
    mimeType: APP_MIME_TYPE,
    text: dashboardAppHtml(),
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
export function dashboardAppHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<title>Baby names by decade</title>
<style>
  body { margin: 0; padding: 16px; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; color: #231f20; }
  h1 { font-size: 16px; font-weight: 600; margin: 0 0 14px; }
  section { margin: 0 0 18px; }
  h2 { font-size: 14px; font-weight: 600; margin: 0 0 6px; }
  h2 span { font-weight: 400; color: #6a6a6a; font-size: 12px; margin-left: 6px; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  h3 { font-size: 11px; font-weight: 500; color: #6a6a6a; margin: 0 0 3px;
       text-transform: uppercase; letter-spacing: .04em; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  td { padding: 2px 0; border-bottom: 1px solid #f2f2f2; }
  td.n { text-align: right; font-variant-numeric: tabular-nums; color: #6a6a6a; }
  .muted { color: #6a6a6a; font-size: 12px; }
</style>
</head>
<body>
<div id="root" class="muted">Loading&hellip;</div>
<script type="module">
(function () {
  var root = document.getElementById("root");
  var lastH = 0;

  function reportSize() {
    var h = Math.max(document.documentElement.scrollHeight,
                     document.body ? document.body.scrollHeight : 0, 80);
    if (h === lastH) return;
    lastH = h;
    parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/size-changed",
      params: { width: Math.ceil(window.innerWidth), height: h } }, "*");
  }

  function esc(v) {
    return String(v).replace(/[&<>]/g, function (c) {
      return c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;";
    });
  }
  function num(v) { return typeof v === "number" ? v.toLocaleString() : esc(v); }

  // First array of objects anywhere in the payload — the query surface owns
  // the envelope, so don't assume a key.
  function findRows(node, depth) {
    if (!node || depth > 6) return null;
    if (Array.isArray(node)) {
      return node.length && node[0] && typeof node[0] === "object" && !Array.isArray(node[0])
        ? node : null;
    }
    if (typeof node !== "object") return null;
    for (var k in node) { var hit = findRows(node[k], depth + 1); if (hit) return hit; }
    return null;
  }

  function nameList(label, list) {
    if (!Array.isArray(list) || !list.length) return "";
    var body = list.map(function (r) {
      var keys = Object.keys(r);
      var nameKey = keys.filter(function (k) { return typeof r[k] === "string"; })[0] || keys[0];
      var numKey = keys.filter(function (k) { return typeof r[k] === "number"; })[0];
      return "<tr><td>" + esc(r[nameKey]) + "</td><td class='n'>"
        + (numKey ? num(r[numKey]) : "") + "</td></tr>";
    }).join("");
    return "<div><h3>" + esc(label) + "</h3><table>" + body + "</table></div>";
  }

  function render(result) {
    var rows = findRows(result && result.structuredContent, 0);
    if (!rows) {
      var text = ((result && result.content) || [])
        .filter(function (c) { return c && c.type === "text"; })
        .map(function (c) { return c.text; }).join(" ");
      root.innerHTML = "<h1>No rows</h1><pre style='white-space:pre-wrap;font-size:12px'>"
        + esc(text.slice(0, 4000)) + "</pre>";
      reportSize();
      return;
    }
    var html = "<h1>Top names by decade</h1>";
    rows.forEach(function (row) {
      var nested = [], scalars = [];
      Object.keys(row).forEach(function (k) {
        if (Array.isArray(row[k])) nested.push(k); else scalars.push(k);
      });
      var headKey = scalars[0];
      var rest = scalars.slice(1)
        .map(function (k) { return esc(k) + " " + num(row[k]); }).join(" · ");
      html += "<section><h2>" + esc(row[headKey])
        + (rest ? "<span>" + rest + "</span>" : "") + "</h2><div class='cols'>"
        + nested.map(function (k) {
            return nameList(k.replace(/_/g, " "), row[k]);
          }).join("")
        + "</div></section>";
    });
    root.className = "";
    root.innerHTML = html;
    reportSize();
  }

  window.addEventListener("message", function (e) {
    var m = e.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.method === "ui/notifications/tool-result") render(m.params);
  });

  reportSize();
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(reportSize).observe(document.documentElement);
  }

  parent.postMessage({
    jsonrpc: "2.0", id: 1, method: "ui/initialize",
    params: {
      protocolVersion: "2026-01-26",
      appInfo: { name: "malloyyo-babynames", version: "0.1.0" },
      appCapabilities: {}
    }
  }, "*");
})();
</script>
</html>
`;
}
