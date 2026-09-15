// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * PROTOTYPE — the smallest possible MCP App: a panel whose text is written by
 * JavaScript. Nothing is rendered by the HTML itself, so if the words appear at
 * all, the host loaded the resource AND ran its script AND the postMessage
 * handshake completed. That is the whole point of starting here: the first
 * attempt framed the wordfinder dashboards and rendered nothing, which left
 * "the host ignored my tool metadata" and "my iframe is broken" indistinguishable.
 *
 * Wire format checked against @modelcontextprotocol/ext-apps@2.0.0 (SEP-1865),
 * which is the SDK MotherDuck's dive viewer ships:
 *
 *   - RESOURCE_MIME_TYPE is "text/html;profile=mcp-app".
 *   - A tool binds a resource with `_meta.ui.resourceUri` (preferred) or the
 *     legacy flat `_meta["ui/resourceUri"]`. The SDK says hosts "must check
 *     both formats", so we send both — a host that only knows the old spelling
 *     is otherwise indistinguishable from one that ignores us.
 *   - `_meta.ui` on the resources/list entry is a listing-level default; the
 *     content item returned by resources/read may carry its own, which TAKES
 *     PRECEDENCE. We now send it in both places; previously only the listing
 *     had it.
 *   - EXTENSION_ID is "io.modelcontextprotocol/ui", negotiated through
 *     `capabilities.extensions`. That is how a client advertises MCP Apps
 *     support, and `getUiCapability()` is how a server reads it — see
 *     clientUiCapability() below, which exists to answer, from logs, whether
 *     the client asking us is willing to render an App at all.
 */

export const HELLO_APP_URI = "ui://malloyyo/hello.html";

export const UI_EXTENSION_ID = "io.modelcontextprotocol/ui";

const MIME = "text/html;profile=mcp-app";

/** The `_meta.ui` block: no network at all is needed to say hello. */
const UI_META = {
  csp: { connectDomains: [], resourceDomains: [], frameDomains: [] },
  prefersBorder: true,
};

/**
 * What the client advertised under `capabilities.extensions`. Logged on every
 * initialize so a silent non-render can be attributed: a client that never
 * advertises the UI extension is telling us it will not render an App, and no
 * amount of server-side metadata will change that.
 */
export function clientUiCapability(params: Record<string, unknown> | undefined) {
  const caps = (params?.capabilities ?? {}) as Record<string, unknown>;
  const extensions = (caps.extensions ?? {}) as Record<string, unknown>;
  return {
    advertisesUi: Object.prototype.hasOwnProperty.call(extensions, UI_EXTENSION_ID),
    ui: extensions[UI_EXTENSION_ID] ?? null,
    extensionIds: Object.keys(extensions),
    capabilityKeys: Object.keys(caps),
  };
}

export function helloAppResource() {
  return {
    uri: HELLO_APP_URI,
    name: "Hello World",
    description: "A minimal MCP App that writes its text from JavaScript.",
    mimeType: MIME,
    _meta: { ui: UI_META },
  };
}

export function helloAppResourceContents() {
  return {
    uri: HELLO_APP_URI,
    mimeType: MIME,
    text: helloAppHtml(),
    // Takes precedence over the listing-level copy above.
    _meta: { ui: UI_META },
  };
}

export function helloAppTool(tag: string) {
  return {
    name: "show_dashboard",
    title: "Show the hello-world panel",
    description:
      `${tag} EXPERIMENTAL — an MCP App smoke test. Renders a small panel whose ` +
      `text is written by JavaScript inside the app. Call it with any message ` +
      `and report to the user whether a panel appeared; the point is the panel, ` +
      `not the text you get back.`,
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Text for the panel to echo. Defaults to 'Hello world'.",
        },
      },
    },
    _meta: {
      // Preferred form.
      ui: { resourceUri: HELLO_APP_URI },
      // Legacy flat form; the SDK says hosts must check both.
      "ui/resourceUri": HELLO_APP_URI,
    },
  };
}

export function isHelloAppTool(name: string) {
  return name === "show_dashboard";
}

export function callHelloApp(args: Record<string, unknown>) {
  const message =
    typeof args.message === "string" && args.message.trim() ? args.message.trim() : "Hello world";
  return {
    content: [
      {
        type: "text",
        text:
          `Rendered the hello-world panel with the message "${message}". Ask the ` +
          `user whether a panel actually appeared above this message — that, not ` +
          `this text, is the result being tested.`,
      },
    ],
    structuredContent: { message },
  };
}

/**
 * The app. `<body>` ships empty on purpose: every visible character is written
 * by the script, so "I see words" cannot be satisfied by static HTML slipping
 * through. It also reports what it heard from the host, which turns a
 * half-working handshake into something readable instead of a blank box.
 */
export function helloAppHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Hello world</title>
<style>
  body { margin: 0; font: 14px/1.6 ui-sans-serif, system-ui, sans-serif; padding: 20px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 12px 0 0; }
  dt { color: #6a6a6a; }
  code { font-family: ui-monospace, monospace; }
</style>
</head>
<body></body>
<script>
(function () {
  var PROTOCOL_VERSION = "2026-01-26";
  var pending = {};
  var nextId = 0;

  function paint(title, rows) {
    var dl = rows.map(function (r) {
      return "<dt>" + r[0] + "</dt><dd><code>" + r[1] + "</code></dd>";
    }).join("");
    document.body.innerHTML = "<h1>" + title + "</h1>" +
      "<div>This text was written by JavaScript inside the MCP App.</div>" +
      "<dl>" + dl + "</dl>";
  }

  // Paint immediately, so a completed handshake is not a precondition for
  // seeing anything. If the panel says "handshake: pending" the resource
  // rendered but the host never answered ui/initialize.
  paint("Hello world", [["handshake", "pending"]]);

  window.addEventListener("message", function (event) {
    var msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0") return;
    if (msg.id != null && pending[msg.id]) {
      var resolve = pending[msg.id];
      delete pending[msg.id];
      resolve(msg.result);
    }
  });

  function request(method, params) {
    var id = ++nextId;
    parent.postMessage({ jsonrpc: "2.0", id: id, method: method, params: params || {} }, "*");
    return new Promise(function (r) { pending[id] = r; });
  }

  request("ui/initialize", {
    protocolVersion: PROTOCOL_VERSION,
    appInfo: { name: "malloyyo-hello", version: "0.1.0" },
    appCapabilities: {}
  }).then(function (result) {
    var host = (result && result.hostInfo) || {};
    paint("Hello world", [
      ["handshake", "ok"],
      ["host", (host.name || "?") + " " + (host.version || "")],
      ["protocol", (result && result.protocolVersion) || "?"]
    ]);
    parent.postMessage({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { height: document.documentElement.scrollHeight }
    }, "*");
  });
})();
</script>
</html>
`;
}
