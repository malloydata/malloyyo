// `malloyyo dashboard dev` — a localhost preview server for dashboard artifacts.
//
// Architecture (matches docs/repo-artifacts.md):
//   - trusted PARENT shell (served at /) holds the one privileged capability:
//     calling the model runner. It brokers postMessage <-> the governed query.
//   - untrusted ARTIFACT runs in a `sandbox="allow-scripts"` iframe (/frame):
//     opaque origin, no credentials, no direct network. It can only postMessage
//     the parent to run a DECLARED query with given values.
//   - the bundle (/bundle.js) is the artifact's Dashboard.tsx compiled with the
//     host frame runtime (React + Malloy's renderer) by esbuild, on demand.
//
// This is a prototype dev server: it runs the SAME engine `run()` the hosted
// server uses, so filter/givens behavior is faithful. It is NOT the production
// serving path (no auth/viewer-scope — a single local dev). Run via the dev
// entry (tsx) so frame-entry.tsx is bundled from source.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { makeRunner, type ModelRunner } from "./host.js";

interface GivenSpec {
  name: string;
  label?: string;
  type: "string" | "number";
  control?: string;
  options?: (string | number)[];
  default: string | number;
}
interface Manifest {
  title: string;
  query: string;
  givens: GivenSpec[];
}
interface Dashboard {
  name: string;
  dir: string;
  manifest: Manifest;
}

/** frame-entry.tsx is a source file bundled at runtime by esbuild (never part of
    the node build). Resolve it whether we're running from src/ (tsx dev) or from
    the built dist/ next to a sibling src/ (local checkout). */
function resolveFrameEntry(): string {
  const candidates = [
    new URL("./frame-entry.tsx", import.meta.url), // dev: src/dashboard.ts
    new URL("../src/frame-entry.tsx", import.meta.url), // built: dist/index.js
  ].map((u) => fileURLToPath(u));
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) {
    throw new Error(
      "frame-entry.tsx not found — `dashboard dev` currently needs the CLI source " +
        "checkout (looked in ./ and ../src). See docs/repo-artifacts.md packaging note.",
    );
  }
  return found;
}

/** Discover ./dashboards/<name>/{manifest.json,Dashboard.tsx} under the root. */
function discoverDashboards(root: string): Dashboard[] {
  const base = path.join(root, "dashboards");
  if (!fs.existsSync(base)) return [];
  const out: Dashboard[] = [];
  for (const name of fs.readdirSync(base)) {
    const dir = path.join(base, name);
    const mf = path.join(dir, "manifest.json");
    if (!fs.statSync(dir).isDirectory() || !fs.existsSync(mf)) continue;
    try {
      out.push({ name, dir, manifest: JSON.parse(fs.readFileSync(mf, "utf8")) });
    } catch (e) {
      console.error(`  ! skipping ${name}: bad manifest.json (${(e as Error).message})`);
    }
  }
  return out;
}

/** Bundle the artifact's Dashboard.tsx with the frame runtime. Cached by the
    Dashboard.tsx mtime so an edit rebuilds (basic hot reload on next load). */
function makeBundler() {
  const cache = new Map<string, { mtimeMs: number; js: string }>();
  const frameEntry = resolveFrameEntry();
  return async function bundle(dash: Dashboard): Promise<string> {
    const dashboardFile = path.join(dash.dir, "Dashboard.tsx");
    const mtimeMs = fs.statSync(dashboardFile).mtimeMs;
    const hit = cache.get(dash.name);
    if (hit && hit.mtimeMs === mtimeMs) return hit.js;
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
            b.onResolve({ filter: /^virtual:dashboard$/ }, () => ({ path: dashboardFile }));
          },
        },
      ],
    });
    const js = result.outputFiles[0].text;
    cache.set(dash.name, { mtimeMs, js });
    return js;
  };
}

const html = (body: string, title: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
  `<meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
  `<body style="margin:0">${body}</body></html>`;

function parentShell(dash: Dashboard, frameBase: string): string {
  // Trusted broker: forwards a run request from the sandboxed frame to /api/run
  // (same-origin to THIS page), then posts the result back into the frame. The
  // frame is served from `frameBase` (a DIFFERENT port = different origin), so
  // `allow-same-origin` gives it a real origin — its worker/wasm/font loads
  // succeed — while it stays cross-origin to this shell: it can't read us or
  // call /api/run directly, only postMessage. See docs/repo-artifacts.md §7/§8.
  const d = JSON.stringify(dash.name);
  const fb = JSON.stringify(frameBase);
  return html(
    `<iframe id="f" sandbox="allow-scripts allow-same-origin"` +
      ` src="${frameBase}/frame?d=${encodeURIComponent(dash.name)}"` +
      ` style="border:0;position:fixed;inset:0;width:100%;height:100%"></iframe>` +
      `<script>
const f=document.getElementById('f');
window.addEventListener('message',async(e)=>{
  if(e.source!==f.contentWindow||e.origin!==${fb})return;
  const m=e.data; if(!m||m.type!=='run')return;
  let out;
  try{
    const res=await fetch('/api/run',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({d:${d},query:m.query,givens:m.givens})});
    out=await res.json();
  }catch(err){ out={ok:false,problems:[{message:String(err)}]}; }
  f.contentWindow.postMessage({type:'result',id:m.id,...out},${fb});
});
</script>`,
    dash.manifest.title,
  );
}

function frameDoc(dash: Dashboard): string {
  // NOTE (prototype): the `sandbox` attribute is the containment here. A
  // production build would also send a strict CSP (connect-src 'none',
  // img-src data:, etc.) to close exfil side-channels — see repo-artifacts.md §8.
  return html(
    `<div id="root"></div>` +
      `<script>window.__MANIFEST__=${JSON.stringify(dash.manifest)}</script>` +
      `<script src="/bundle.js?d=${encodeURIComponent(dash.name)}"></script>`,
    dash.manifest.title,
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

  const dashboards = discoverDashboards(root);
  if (dashboards.length === 0) {
    throw new Error(`No dashboards found under ${path.join(root, "dashboards")}/`);
  }
  const byName = new Map(dashboards.map((d) => [d.name, d]));
  const runner: ModelRunner = await makeRunner(root);
  if (!runner.entryExists()) {
    throw new Error(`No index.malloy at ${root} — run this from a Malloy model repo.`);
  }
  const bundle = makeBundler();

  const pick = (url: URL): Dashboard =>
    byName.get(url.searchParams.get("d") ?? dashboards[0].name) ?? dashboards[0];

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
          return send(200, "text/html; charset=utf-8", frameDoc(pick(url)));
        }
        if (url.pathname === "/bundle.js") {
          return send(200, "application/javascript; charset=utf-8", await bundle(pick(url)));
        }
        return send(404, "text/plain", "not found");
      }
      // Parent origin: the trusted shell + the runner.
      if (url.pathname === "/") {
        return send(200, "text/html; charset=utf-8", parentShell(pick(url), frameBase));
      }
      if (url.pathname === "/api/run" && req.method === "POST") {
        const { d, query, givens } = JSON.parse(await readBody(req));
        const dash = byName.get(d);
        if (!dash) return send(404, "application/json", JSON.stringify({ ok: false, problems: [{ message: `no dashboard '${d}'` }] }));
        // Governance: only run queries this dashboard declared.
        if (query !== dash.manifest.query) {
          return send(403, "application/json", JSON.stringify({ ok: false, problems: [{ message: `query '${query}' is not declared by ${d}` }] }));
        }
        const out = await runner.run(query, givens ?? {});
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
    console.error(`    • ${d.name}  →  http://localhost:${port}/?d=${d.name}`);
  }
  console.error(`  Ctrl-C to stop.\n`);
  await new Promise<void>(() => {});
}
