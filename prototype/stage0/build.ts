// Stage 0: can the frame runtime render inside an MCP App panel at all?
//
// The panel IS the frame — no nested iframe. So the document is exactly what
// /api/dashboards/.../frame emits, with every external script inlined, because
// a panel cannot fetch from our origin.
//
// Deliberately NO query: this isolates one question — does a 4.4 MB vendor
// bundle that compiles with the Function constructor survive the host's
// sandbox CSP, which has no way to request 'unsafe-eval'?
import { readFileSync, writeFileSync } from "node:fs";
import { bundleDashboard } from "../../src/lib/dashboards/bundle";
import { FRAME_BOOTSTRAP } from "../../src/lib/dashboards/frame-html";

const TRIVIAL = `
import { useState } from "react";

export default function Trivial() {
  const [n, setN] = useState(0);
  return (
    <div style={{ padding: 16, font: "14px ui-sans-serif, system-ui" }}>
      <h1 style={{ fontSize: 16, margin: "0 0 8px" }}>Frame runtime loaded</h1>
      <p style={{ margin: "0 0 12px", opacity: 0.7 }}>
        React mounted through the dashboard runtime, inside an MCP App panel.
        No query was run.
      </p>
      <button onClick={() => setN(n + 1)}>clicked {n} times</button>
    </div>
  );
}
`;

async function main() {
const vendor = readFileSync("public/dashboard-vendor.js", "utf8");

// The panel is BOTH the frame and an MCP App. Without the SDK it never sends
// ui/initialize or size-changed, so the host gives it no height and the panel
// is blank — indistinguishable from a render failure.
const sdkRaw = readFileSync(
  "node_modules/@modelcontextprotocol/ext-apps/dist/src/app-with-deps.js",
  "utf8",
);
const m = sdkRaw.match(/export\s*\{([^}]*)\}\s*;?\s*$/);
if (!m) throw new Error("could not find the SDK bundle's export statement");
const globals = m[1]
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean)
  .map((x) => {
    const [local, , exported] = x.split(/\s+/);
    return `${JSON.stringify(exported ?? local)}: ${local}`;
  })
  .join(", ");
const sdk = sdkRaw.slice(0, m.index) + `globalThis.__EXT_APPS__ = {${globals}};`;
const dash = await bundleDashboard(TRIVIAL);

const info = { name: "stage0", title: "Stage 0", description: "runtime smoke test" };

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<title>Stage 0</title>
</head>
<body style="margin:0">
<div id="root">loading runtime…</div>
<script>
window.__DASHBOARD__ = ${JSON.stringify(info)};
window.__DASHBOARDS__ = [];
window.__GIVENS__ = [];
</script>
<script>${FRAME_BOOTSTRAP}</script>
<script>
// Report anything that dies, so a blank panel is never the only symptom —
// a CSP refusal of eval shows up here rather than as silence.
window.addEventListener("error", function (e) {
  var r = document.getElementById("root");
  if (r) r.innerHTML = "<pre style='white-space:pre-wrap;padding:12px;font:12px ui-monospace'>" +
    String(e.message || e) + "</pre>";
});
</script>
<script type="module">
${sdk}
</script>
<script>${vendor}</script>
<script id="dash-src" type="text/plain">${Buffer.from(dash, "utf8").toString("base64")}</script>
<script type="module">
// Can a panel execute code delivered as a string? MotherDuck's one-viewer
// design depends on it; ours can avoid it with one resource per dashboard.
const src = new TextDecoder().decode(Uint8Array.from(atob(document.getElementById("dash-src").textContent.trim()), (c) => c.charCodeAt(0)));
const log = [];
let ok = false;

// 1. blob: module import — the cleanest, no eval.
try {
  const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  await import(url);
  log.push("blob import: OK");
  ok = true;
} catch (e) { log.push("blob import: " + (e && e.message || e)); }

// 2. data: URL module import.
if (!ok) try {
  await import("data:text/javascript," + encodeURIComponent(src));
  log.push("data import: OK");
  ok = true;
} catch (e) { log.push("data import: " + (e && e.message || e)); }

// 3. Function constructor — needs unsafe-eval.
if (!ok) try {
  new Function(src)();
  log.push("new Function: OK");
  ok = true;
} catch (e) { log.push("new Function: " + (e && e.message || e)); }

window.__INJECT_LOG__ = log;
if (!ok) {
  document.getElementById("root").innerHTML =
    "<pre style='white-space:pre-wrap;padding:12px;font:12px ui-monospace'>DYNAMIC LOAD FAILED " +
    log.join(" | ") + "</pre>";
} else {
  const n = document.createElement("div");
  n.style.cssText = "padding:8px 16px;font:11px ui-monospace;opacity:.6";
  n.textContent = log.join(" | ");
  document.body.appendChild(n);
}
</script>
<script type="module">
// Connect to the host AFTER the dashboard has mounted, and report height so
// the panel is not zero-height. This is the only MCP-App-specific code in the
// document; everything above it is the ordinary frame.
const { App } = globalThis.__EXT_APPS__;
const app = new App({ name: "Malloyyo Frame", version: "0.1.0" });
app.onerror = console.error;
app.onteardown = async () => ({});
app.connect().then(() => app.setupSizeChangedNotifications());
</script>
</body>
</html>
`;

writeFileSync("prototype/stage0/panel.html", html);
console.log(`vendor ${(vendor.length / 1048576).toFixed(1)} MB + dashboard ${(dash.length / 1024).toFixed(0)} KB`);
console.log(`panel.html ${(html.length / 1048576).toFixed(1)} MB`);
}
main();
