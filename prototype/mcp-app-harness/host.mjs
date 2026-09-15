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
const appHtml = fs.readFileSync(path.join(here, "app.html"), "utf8");
const PORT = 4181;

const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>MCP Apps host (harness)</title>
<style>
 body{font:14px/1.5 ui-sans-serif,system-ui,sans-serif;margin:0;background:#faf9f7;color:#231f20}
 header{padding:10px 16px;border-bottom:1px solid #e6e3de}
 #log{font:11px ui-monospace,monospace;color:#6a6a6a}
 #panel{margin:16px;border:1px solid #e6e3de;border-radius:10px;background:#fff;overflow:hidden}
 iframe{display:block;width:100%;border:0;height:150px}
</style></head>
<body>
<header><b>Host harness</b> <span id="log">waiting…</span></header>
<div id="panel"><iframe id="app" sandbox="allow-scripts"></iframe></div>
<script>
const APP_HTML = ${JSON.stringify(appHtml).replace(/<\//g, "<\\/")};
const events = []; window.__events = events;
const log = (s) => { events.push(s); document.getElementById("log").textContent = events.join("  ·  "); };
const app = document.getElementById("app");
app.srcdoc = APP_HTML;
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

http.createServer((_q, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page);
}).listen(PORT, "127.0.0.1", () => console.log("host http://127.0.0.1:" + PORT));
