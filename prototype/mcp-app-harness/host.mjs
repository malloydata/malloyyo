// A stand-in MCP Apps HOST for the hello-world app.
//
// Reproduces the part that can actually break: the app runs in a sandboxed
// iframe WITHOUT allow-same-origin, so it gets an opaque origin, exactly as a
// real host gives it. Answers ui/initialize and records what the app sends.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// The published dashboard site, served locally so the inner iframe resolves.
const DOCS = process.env.WORDFINDER_DOCS;
if (DOCS) {
  const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".parquet": "application/octet-stream",
    ".json": "application/json", ".wasm": "application/wasm" };
  http.createServer((req, res) => {
    const file = path.join(DOCS, path.normalize(new URL(req.url, "http://x").pathname).replace(/^\/+/, ""));
    if (!file.startsWith(DOCS) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { "Access-Control-Allow-Origin": "*" }).end("not found"); return;
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
      // The opaque-origin app iframe makes every one of these cross-origin.
      "Access-Control-Allow-Origin": "*" });
    fs.createReadStream(file).pipe(res);
  }).listen(4180, "127.0.0.1", () => console.log("site  http://127.0.0.1:4180"));
}
const appHtml = fs.readFileSync(path.join(here, "app.html"), "utf8");
const toolResult = JSON.parse(fs.readFileSync(path.join(here, "tool-result.json"), "utf8"));
const PORT = 4181;

const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>MCP Apps host (harness)</title>
<style>
 body{font:14px/1.5 ui-sans-serif,system-ui,sans-serif;margin:0;background:#faf9f7;color:#231f20}
 header{padding:10px 16px;border-bottom:1px solid #e6e3de}
 #log{font:11px ui-monospace,monospace;color:#6a6a6a}
 #panel{margin:16px;border:1px solid #e6e3de;border-radius:10px;background:#fff;overflow:hidden}
 iframe{display:block;width:100%;border:0;height:700px}
</style></head>
<body>
<header><b>Host harness</b> <span id="log">waiting…</span></header>
<div id="panel"><iframe id="app" sandbox="allow-scripts allow-same-origin allow-popups allow-forms"></iframe></div>
<script>
const TOOL_RESULT = ${JSON.stringify(toolResult).replace(/<\//g, "<\\/").replace(/\u2028|\u2029/g, "")};
const events = []; window.__events = events;
const log = (s) => { events.push(s); document.getElementById("log").textContent = events.join("  ·  "); };
const app = document.getElementById("app");
app.src = "/app.html";
window.addEventListener("message", (e) => {
  const m = e.data;
  if (!m || m.jsonrpc !== "2.0") return;
  if (m.method === "ui/initialize") {
    log("ui/initialize");
    app.contentWindow.postMessage({ jsonrpc:"2.0", id:m.id, result:{
      protocolVersion:"2026-01-26",
      hostInfo:{name:"harness",version:"0"},
      hostCapabilities:{}, hostContext:{theme:"light",displayMode:"inline"},
    }}, "*");
    // Then push the tool result, as a real host does after the handshake.
    setTimeout(() => {
      log("\u2192 tool-result");
      app.contentWindow.postMessage({
        jsonrpc: "2.0", method: "ui/notifications/tool-result", params: TOOL_RESULT,
      }, "*");
    }, 50);
    return;
  }
  if (m.method === "ui/notifications/size-changed") {
    log("size-changed " + m.params.height);
    app.style.height = Math.max(120, m.params.height) + "px";
    return;
  }
  log(m.method || ("id:" + m.id));
});
</script></body></html>`;

http.createServer((q, res) => {
  if ((q.url || "").startsWith("/app.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(appHtml);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page);
}).listen(PORT, "127.0.0.1", () => console.log("host http://127.0.0.1:" + PORT));
