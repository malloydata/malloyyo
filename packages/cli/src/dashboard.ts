// `malloyyo dashboard dev` — a localhost preview server for dashboard artifacts.
//
// Architecture (matches docs/repo-artifacts.md):
//   - the MODEL declares its dashboards: a top-level query tagged `# artifact`
//     (optionally title="…"/name="…"). There is no manifest file — the tag is
//     the manifest, and the query's given: declarations are the filter contract.
//   - `./dashboards/<name>/Dashboard.tsx` OPTIONALLY customizes the component;
//     without one the runtime renders its DefaultDashboard (auto controls from
//     the given specs + the result panel).
//   - trusted PARENT shell (served at /) holds the one privileged capability:
//     calling the model runner. It brokers postMessage <-> governed queries.
//   - untrusted ARTIFACT runs in a `sandbox="allow-scripts"` iframe (/frame):
//     opaque origin, no credentials, no direct network. It can only postMessage
//     the parent to run a model-published named query or restricted Malloy text.
//   - the bundle (/bundle.js) is the artifact's component compiled with the
//     shared frame runtime (src/frame-runtime/) by esbuild, on demand.
//
// This is a prototype dev server: it runs the SAME engine `run()` the hosted
// server uses, so filter/givens behavior is faithful. It is NOT the production
// serving path (no auth/viewer-scope — a single local dev). Run via the dev
// entry (tsx) so the frame runtime is bundled from source.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as esbuild from "esbuild";
import { makeRunner, type GivenSpec, type ModelRunner, type TileSpec } from "./host.js";

// The dashboard's Dashboard.tsx lives in the user's model repo, which may be
// anywhere on disk (outside this monorepo). Its `react` / automatic-JSX imports
// must resolve to the CLI's OWN copies, not the model repo's node_modules (which
// usually don't exist). Resolve them once from here and alias them at bundle time.
const require = createRequire(import.meta.url);
const HOST_LIBS = [
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "@malloydata/render",
  "@malloydata/malloy-filter",
];
const HOST_ALIAS: Record<string, string> = {};
for (const spec of HOST_LIBS) {
  try {
    HOST_ALIAS[spec] = require.resolve(spec);
  } catch {
    /* optional (jsx-dev-runtime may be absent) */
  }
}

/** A dashboard = a `# artifact`-tagged query, plus an optional custom component. */
interface Dashboard {
  name: string;
  query: string;
  title: string;
  description?: string;
  /** Composite dashboard: tile run-expressions run separately and combined into
      one `# dashboard` result. Present iff composite (then `query` is ""). */
  tiles?: string[];
  /** Composite only: pass-through to the dashboard nest's `columns`. */
  dashboard_columns?: number;
  /** Per-dashboard given defaults from the tag's `givens { … }` block. */
  givens?: Record<string, string | number | boolean>;
  /** `# artifact { autorun=false }` → stage control changes behind an Apply
      button. Absent = live (re-run on every change). */
  autorun?: boolean;
  /** Structure v2: the dashboard's own file, relative to the project root
      (`dashboards/<name>.malloy`) — compiled AS the entry to run its tiles. */
  entryFile?: string;
  /** Path to the optional custom component: `dashboards/<name>.jsx` (or .tsx). */
  tsxPath?: string;
}

/** Runtime source files, resolved whether we're running from src/ (tsx dev) or
    from the built dist/ next to a sibling src/ (local checkout). */
function resolveRuntimeDir(): string {
  const candidates = [
    new URL("./frame-runtime/", import.meta.url), // dev: src/dashboard.ts
    new URL("../src/frame-runtime/", import.meta.url), // built: dist/index.js
  ].map((u) => fileURLToPath(u));
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) {
    throw new Error(
      "frame-runtime/ not found — `dashboard dev` currently needs the CLI source " +
        "checkout (looked in ./ and ../src). See docs/repo-artifacts.md packaging note.",
    );
  }
  return found;
}
const resolveFrameEntry = (): string => path.join(resolveRuntimeDir(), "..", "frame-entry.tsx");

/** Structure v2: each `dashboards/<name>.malloy` is one dashboard, compiled AS
    its own entry to read its `## artifact`. The optional custom component is a
    flat sibling `dashboards/<name>.jsx` (or .tsx). A `.malloy` with no
    `## artifact` is skipped (e.g. a shared include). */
async function discoverDashboards(root: string, runner: ModelRunner): Promise<Dashboard[]> {
  const dir = path.join(root, "dashboards");
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".malloy"))
    .sort();
  const dashboards: Dashboard[] = [];
  for (const file of files) {
    const base = file.slice(0, -".malloy".length);
    const entryFile = path.join("dashboards", file); // relative to root (leaseIn joins it)
    const res = await runner.artifactForFile(entryFile, base);
    if (!res.ok) throw new Error(`dashboard ${file}: ${res.error}`);
    if (!res.artifact) continue; // no `## artifact` in this file — not a dashboard
    const component = ["jsx", "tsx"]
      .map((ext) => path.join(dir, `${base}.${ext}`))
      .find((p) => fs.existsSync(p));
    dashboards.push({ ...res.artifact, name: res.artifact.name || base, entryFile, tsxPath: component });
  }
  return dashboards;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Bundle the artifact's component with the frame runtime. Cached by the
    mtimes of the component AND every runtime source file, so an edit to either
    rebuilds (basic hot reload on next load). */
function makeBundler() {
  const cache = new Map<string, { stamp: number; js: string }>();
  const frameEntry = resolveFrameEntry();
  const runtimeDir = resolveRuntimeDir();
  const runtimeIndex = path.join(runtimeDir, "index.ts");
  const runtimeStamp = () =>
    fs.statSync(frameEntry).mtimeMs +
    fs
      .readdirSync(runtimeDir)
      .map((f) => fs.statSync(path.join(runtimeDir, f)).mtimeMs)
      .reduce((a, b) => a + b, 0);
  return async function bundle(dash: Dashboard): Promise<string> {
    const stamp = runtimeStamp() + (dash.tsxPath ? fs.statSync(dash.tsxPath).mtimeMs : 0);
    const hit = cache.get(dash.name);
    if (hit && hit.stamp === stamp) return hit.js;
    const result = await esbuild.build({
      entryPoints: [frameEntry],
      bundle: true,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      write: false,
      logLevel: "silent",
      loader: { ".css": "empty" },
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [
        {
          name: "virtual-dashboard",
          setup(b) {
            // The tagged query may ship no component — mount the runtime's
            // DefaultDashboard (mountDashboard treats null as "use default").
            if (dash.tsxPath) {
              const tsxPath = dash.tsxPath;
              b.onResolve({ filter: /^virtual:dashboard$/ }, () => ({ path: tsxPath }));
            } else {
              b.onResolve({ filter: /^virtual:dashboard$/ }, () => ({
                path: "default-dashboard",
                namespace: "vdefault",
              }));
              b.onLoad({ filter: /.*/, namespace: "vdefault" }, () => ({
                contents: `export default null;`,
                loader: "js",
              }));
            }
            // A Dashboard.tsx imports the runtime as "@malloyyo/dashboard".
            b.onResolve({ filter: /^@malloyyo\/dashboard$/ }, () => ({ path: runtimeIndex }));
            // Force react / renderer / filter-parser imports to the CLI's
            // copies, whatever directory the dashboard file lives in.
            b.onResolve(
              { filter: /^(react($|\/)|react-dom($|\/)|@malloydata\/(render|malloy-filter)$)/ },
              (args) => (HOST_ALIAS[args.path] ? { path: HOST_ALIAS[args.path] } : undefined),
            );
          },
        },
      ],
    });
    const js = result.outputFiles[0].text;
    cache.set(dash.name, { stamp, js });
    return js;
  };
}

const html = (body: string, title: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
  `<meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
  `<body style="margin:0">${body}</body></html>`;

function parentShell(
  dash: Dashboard,
  frameBase: string,
  all: Dashboard[],
  initialGivens: Record<string, string>,
): string {
  const givensQs = Object.entries(initialGivens)
    .map(([k, v]) => `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("");
  // Trusted broker: forwards a run request from the sandboxed frame to /api/run
  // (same-origin to THIS page), then posts the result back into the frame. The
  // frame is served from `frameBase` (a DIFFERENT port = different origin), so
  // `allow-same-origin` gives it a real origin — its worker/wasm/font loads
  // succeed — while it stays cross-origin to this shell: it can't read us or
  // call /api/run directly, only postMessage. See docs/repo-artifacts.md §7/§8.
  const d = JSON.stringify(dash.name);
  const fb = JSON.stringify(frameBase);
  const nav =
    all.length > 1
      ? `<nav style="display:flex;gap:4px;align-items:center;padding:8px 12px;` +
        `background:#f6f7f9;border-bottom:1px solid #e2e4e8;font:13px system-ui,sans-serif">` +
        `<span style="color:#888;margin-right:8px">Dashboards</span>` +
        all
          .map((x) => {
            const on = x.name === dash.name;
            return (
              `<a href="/?d=${encodeURIComponent(x.name)}" style="padding:4px 10px;` +
              `border-radius:6px;text-decoration:none;${on ? "background:#1a1a1a;color:#fff" : "color:#333"}">` +
              `${esc(x.title || x.name)}</a>`
            );
          })
          .join("") +
        `</nav>`
      : "";
  return html(
    `<div style="display:flex;flex-direction:column;height:100vh">` +
      nav +
      // allow-popups(+escape-sandbox): let a # link mark open its target in a
      // normal new tab on click instead of being blocked by the sandbox.
      `<iframe id="f" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"` +
      ` src="${frameBase}/frame?d=${encodeURIComponent(dash.name)}${givensQs}"` +
      ` style="border:0;flex:1;width:100%"></iframe>` +
      `</div>` +
      `<script>
const f=document.getElementById('f');
try{new EventSource('/events').onmessage=()=>location.reload();}catch(e){}
window.addEventListener('message',async(e)=>{
  if(e.source!==f.contentWindow||e.origin!==${fb})return;
  const m=e.data;
  if(m&&m.type==='givens'){
    const u=new URL(location.href); u.search='';
    u.searchParams.set('d',${d});
    for(const [k,v] of Object.entries(m.givens)) if(v!=null&&String(v)!=='') u.searchParams.set('$'+k,String(v));
    history.replaceState(null,'',u.pathname+u.search);
    return;
  }
  if(m&&m.type==='navigate'&&typeof m.dashboard==='string'){
    const u=new URL(location.href); u.search='';
    u.searchParams.set('d',m.dashboard);
    for(const [k,v] of Object.entries(m.givens||{})) if(v!=null&&String(v)!=='') u.searchParams.set('$'+k,String(v));
    location.href=u.pathname+u.search;
    return;
  }
  if(!m||m.type!=='run')return;
  let out;
  try{
    const res=await fetch('/api/run',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({d:${d},query:m.query,malloy:m.malloy,givens:m.givens,dashboard:m.dashboard})});
    out=await res.json();
  }catch(err){ out={ok:false,problems:[{message:String(err)}]}; }
  f.contentWindow.postMessage({type:'result',id:m.id,...out},${fb});
});
</script>`,
    dash.title,
  );
}

/** URL query minus the `d` (dashboard) selector = the givens/filter values. */
function givensFromUrl(url: URL): Record<string, string> {
  const g: Record<string, string> = {};
  for (const [k, v] of url.searchParams) if (k !== "d") g[k] = v;
  return g;
}

function frameDoc(
  dash: Dashboard,
  givenSpecs: GivenSpec[],
  initialGivens: Record<string, string>,
  tileSpecs?: TileSpec[],
): string {
  // NOTE (prototype): the `sandbox` attribute is the containment here. A
  // production build would also send a strict CSP (connect-src 'none',
  // img-src data:, etc.) to close exfil side-channels — see repo-artifacts.md §8.
  const info = {
    name: dash.name,
    query: dash.query,
    title: dash.title,
    description: dash.description,
    tiles: dash.tiles,
    // Per-tile run/name/given-names for the independent-grid renderer (composite
    // only). Each tile runs with just the givens it references.
    tileSpecs,
    dashboard_columns: dash.dashboard_columns,
    givens: dash.givens,
    autorun: dash.autorun,
  };
  return html(
    `<div id="root"></div>` +
      `<script>window.__DASHBOARD__=${JSON.stringify(info)};` +
      `window.__GIVENS__=${JSON.stringify(givenSpecs)};` +
      `window.__INITIAL_GIVENS__=${JSON.stringify(initialGivens)}</script>` +
      `<script src="/bundle.js?d=${encodeURIComponent(dash.name)}"></script>`,
    dash.title,
  );
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function serveDashboard(opts: {
  root?: string;
  port?: number;
}): Promise<void> {
  await import("@malloydata/malloy-connections");
  const root = path.resolve(opts.root ?? process.cwd());
  const port = opts.port ?? 4173;
  // The untrusted artifact is served from a SECOND origin (port+1). That lets
  // its iframe use `allow-same-origin` (so Malloy's renderer can load workers/
  // wasm) while staying cross-origin to the trusted shell — the frame still
  // can't read the shell or reach /api/run except via postMessage.
  const framePort = port + 1;
  const frameBase = `http://localhost:${framePort}`;

  const runner: ModelRunner = await makeRunner(root);
  if (!runner.entryExists()) {
    throw new Error(`No index.malloy at ${root} — run this from a Malloy model repo.`);
  }
  let dashboards = await discoverDashboards(root, runner);
  if (dashboards.length === 0) {
    throw new Error(
      `No dashboards declared — tag a top-level query with \`# artifact title="…"\` in the model.`,
    );
  }
  let byName = new Map(dashboards.map((d) => [d.name, d]));
  const bundle = makeBundler();

  const pick = (url: URL): Dashboard =>
    byName.get(url.searchParams.get("d") ?? dashboards[0].name) ?? dashboards[0];

  // Live reload: watch the model + dashboards and tell the browser to reload on
  // any change. The runner reads model files fresh per run, the bundle cache is
  // keyed by mtime, and we re-discover the tagged queries here — so a reload
  // picks up edits to .malloy (including # artifact tags) or Dashboard.tsx
  // without a restart.
  const sseClients = new Set<http.ServerResponse>();
  const notifyReload = () => {
    for (const c of sseClients) c.write("data: reload\n\n");
  };
  let debounce: ReturnType<typeof setTimeout> | undefined;
  try {
    fs.watch(root, { recursive: true }, (_evt, filename) => {
      const f = filename?.toString() ?? "";
      if (!f.endsWith(".malloy") && !f.includes("dashboards")) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        discoverDashboards(root, runner)
          .then((next) => {
            dashboards = next;
            byName = new Map(dashboards.map((d) => [d.name, d]));
            console.error(`  ↻ ${f} changed — reloading`);
            notifyReload();
          })
          .catch((e) => console.error(`  ! model error after ${f} changed: ${(e as Error).message}`));
      }, 150);
    });
  } catch (e) {
    console.error(`  (file watch unavailable: ${(e as Error).message} — edits won't auto-reload)`);
  }

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const onFramePort = (req.socket.localPort ?? port) === framePort;
    const url = new URL(req.url ?? "/", `http://localhost:${onFramePort ? framePort : port}`);
    const send = (code: number, type: string, body: string, extra: Record<string, string> = {}) => {
      res.writeHead(code, { "content-type": type, ...extra });
      res.end(body);
    };
    try {
      // Frame origin (port+1): ONLY the untrusted artifact document + its bundle.
      // Never /api/run — so the frame (same-origin only to THIS port) can't reach
      // the runner on its own origin.
      if (onFramePort) {
        if (url.pathname === "/frame") {
          // Given specs are introspected from the model PER LOAD, so an edit to
          // a `given:` declaration (type, default, tags) shows up on reload.
          const dash = pick(url);
          // Composite: the controls are the UNION of givens across its tiles, and
          // each tile carries the given NAMES it references so the grid runs it
          // in isolation. A single artifact = the one query's givens.
          if (dash.tiles && dash.entryFile) {
            const t = await runner.dashboardTiles(dash.entryFile, dash.tiles);
            return send(200, "text/html; charset=utf-8", frameDoc(dash, t.union, givensFromUrl(url), t.tiles));
          }
          const specs = await runner.givensForQuery(dash.query);
          if (!specs.ok) {
            return send(200, "text/html; charset=utf-8",
              html(`<pre style="color:crimson;padding:16px">model error: ${esc(specs.error)}</pre>`, dash.title));
          }
          return send(200, "text/html; charset=utf-8", frameDoc(dash, specs.givens, givensFromUrl(url)));
        }
        if (url.pathname === "/bundle.js") {
          return send(200, "application/javascript; charset=utf-8", await bundle(pick(url)));
        }
        return send(404, "text/plain", "not found");
      }
      // Parent origin: the trusted shell + the runner.
      // Live-reload stream: the shell subscribes and reloads on a file change.
      if (url.pathname === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write("retry: 1000\n\n");
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
      }
      if (url.pathname === "/") {
        return send(200, "text/html; charset=utf-8", parentShell(pick(url), frameBase, dashboards, givensFromUrl(url)));
      }
      if (url.pathname === "/api/run" && req.method === "POST") {
        const { d, query, malloy, givens, dashboard } = JSON.parse(await readBody(req));
        const dash = byName.get(d);
        if (!dash) return send(404, "application/json", JSON.stringify({ ok: false, problems: [{ message: `no dashboard '${d}'` }] }));
        // Governance: a dashboard may run (a) the whole COMPOSITE (its declared
        // tiles), (b) any named query the model publishes, or (c) restricted
        // Malloy text — core's restricted mode (no import / given: / connection.*
        // / raw SQL / ##! flags) is the gate, the contract the explore MCP
        // surface runs under. A `dashboard` request runs only the tiles the
        // model declared, never arbitrary tiles from the frame.
        // A v2 dashboard runs everything against its OWN file (its inline query /
        // imports live there, not index.malloy); v1 falls back to index.malloy.
        const entry = dash.entryFile;
        const out =
          dashboard && dash.tiles && entry
            ? await runner.runDashboard(entry, dash.tiles, { columns: dash.dashboard_columns, givens: givens ?? {} })
            : typeof malloy === "string"
              ? entry
                ? await runner.runTextIn(entry, malloy, givens ?? {})
                : await runner.runText(malloy, givens ?? {})
              : entry
                ? await runner.runIn(entry, String(query ?? ""), givens ?? {})
                : await runner.run(String(query ?? dash.query), givens ?? {});
        return send(200, "application/json", JSON.stringify(out));
      }
      send(404, "text/plain", "not found");
    } catch (e) {
      send(500, "application/json", JSON.stringify({ ok: false, problems: [{ message: (e as Error).message }] }));
    }
  };

  const shellServer = http.createServer(handler);
  const frameServer = http.createServer(handler);
  await new Promise<void>((r) => shellServer.listen(port, r));
  await new Promise<void>((r) => frameServer.listen(framePort, r));
  console.error(`\n  malloyyo dashboard dev — model: ${root}`);
  console.error(`  http://localhost:${port}/   (artifact origin: ${frameBase})`);
  for (const d of dashboards) {
    const kind = d.tsxPath ? "custom" : "default UI";
    console.error(`    • ${d.name} (${kind})  →  http://localhost:${port}/?d=${d.name}`);
  }
  console.error(`  Ctrl-C to stop.\n`);
  await new Promise<void>(() => {});
}
