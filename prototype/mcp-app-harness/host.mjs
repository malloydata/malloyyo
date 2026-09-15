// A stand-in MCP Apps HOST, to exercise the app HTML without claude.ai.
//
// It reproduces the parts that can actually break:
//   - the app runs in a sandboxed iframe WITHOUT allow-same-origin (an opaque
//     origin), which is what a real host gives it;
//   - the handshake is JSON-RPC over postMessage: ui/initialize in, then
//     ui/notifications/tool-result out;
//   - the dashboard is served from a different origin than the app, with
//     CORS open, the way GitHub Pages serves the real one.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DOCS = process.env.WORDFINDER_DOCS ?? "../wordfinder/docs";
const SITE_PORT = 4180;
const HOST_PORT = 4181;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".parquet": "application/octet-stream",
  ".json": "application/json",
  ".wasm": "application/wasm",
};

// --- the "published dashboard site" -----------------------------------------
http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const file = path.join(DOCS, path.normalize(url.pathname).replace(/^\/+/, ""));
    if (!file.startsWith(DOCS) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { "Access-Control-Allow-Origin": "*" }).end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
      // An opaque-origin iframe makes every one of these cross-origin.
      "Access-Control-Allow-Origin": "*",
    });
    fs.createReadStream(file).pipe(res);
  })
  .listen(SITE_PORT, "127.0.0.1", () => console.log("site  http://127.0.0.1:" + SITE_PORT));

// --- the host page -----------------------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url));
const appHtml = fs.readFileSync(path.join(here, "app.html"), "utf8");
const toolResult = JSON.parse(fs.readFileSync(path.join(here, "tool-result.json"), "utf8"));

const hostPage = `<!doctype html>
<html><head><meta charset="utf-8"><title>MCP Apps host (harness)</title>
<style>
 body{font:14px/1.5 ui-sans-serif,system-ui,sans-serif;margin:0;background:#faf9f7;color:#231f20}
 header{padding:10px 16px;border-bottom:1px solid #e6e3de;display:flex;gap:12px;align-items:baseline}
 h1{font-size:14px;margin:0;font-weight:600}
 #log{font:11px ui-monospace,monospace;color:#6a6a6a}
 #panel{margin:16px;border:1px solid #e6e3de;border-radius:10px;overflow:hidden;background:#fff}
 iframe{display:block;width:100%;border:0;height:200px}
</style></head>
<body>
<header><h1>Host harness</h1><span id="log">waiting…</span></header>
<div id="panel">
  <iframe id="app" sandbox="allow-scripts allow-forms allow-popups"></iframe>
</div>
<script>
// The app HTML closes a script tag of its own; escape it or it closes this one.
const APP_HTML = ${JSON.stringify(appHtml).replace(/<\//g, "<\\/")};
const TOOL_RESULT = ${JSON.stringify(toolResult)};
const events = [];
const log = (s) => { events.push(s); document.getElementById("log").textContent = events.join("  ·  "); };
window.__events = events;

const app = document.getElementById("app");
app.srcdoc = APP_HTML;

window.addEventListener("message", (e) => {
  const msg = e.data;
  if (!msg || msg.jsonrpc !== "2.0") return;
  if (msg.method === "ui/initialize") {
    log("ui/initialize");
    // Answer the handshake, then push the tool result, as the host does.
    app.contentWindow.postMessage({
      jsonrpc: "2.0", id: msg.id,
      result: {
        protocolVersion: "2026-01-26",
        hostInfo: { name: "harness", version: "0" },
        hostCapabilities: { sandbox: {} },
        hostContext: { theme: "light", displayMode: "inline" },
      },
    }, "*");
    setTimeout(() => {
      log("→ tool-result");
      app.contentWindow.postMessage({
        jsonrpc: "2.0", method: "ui/notifications/tool-result", params: TOOL_RESULT,
      }, "*");
    }, 50);
    return;
  }
  if (msg.method === "ui/notifications/size-changed") {
    log("size-changed " + msg.params.height);
    app.style.height = msg.params.height + "px";
    return;
  }
  log(msg.method || ("id:" + msg.id));
});
</script></body></html>`;

http
  .createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(hostPage);
  })
  .listen(HOST_PORT, "127.0.0.1", () => console.log("host  http://127.0.0.1:" + HOST_PORT));
