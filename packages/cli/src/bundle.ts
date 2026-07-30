// `malloyyo dashboard bundle` — compile a model repo's dashboards into a
// directory of static files (default `docs/`, so GitHub Pages can serve it
// straight from the branch).
//
// The published site has NO server, NO token, NO database. Malloy compiles in
// the browser and DuckDB-WASM runs the SQL against whatever the model's sources
// point at (an https:// parquet, typically). That is the whole security model:
// there is no privileged capability in the deployment to leak, and what gets
// served is exactly what someone committed.
//
// Everything that can move to build time does: model sources are inlined,
// dashboards are discovered and their components bundled, and the DuckDB assets
// are copied in. At runtime the page fetches only its data.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import * as esbuild from "esbuild";
import { makeRunner, type ModelRunner } from "./host.js";
import { readSiteConfig } from "./config.js";
import {
  discoverDashboards,
  resolveRuntimeDir,
  hostAliasPlugin,
  browserBuildBase,
  type Dashboard,
} from "./discover.js";
import { navHtml as sharedNav, NAV_CSS } from "./shared/nav.js";
import { serveStatic } from "./static-server.js";

const require = createRequire(import.meta.url);

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Every .malloy in the project, keyed by the file:// URL Malloy resolves
    imports against. `import "../index.malloy"` from dashboards/x.malloy must
    land on file:///index.malloy, so the keys mirror the on-disk layout. */
function inlineModelFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const skip = new Set(["node_modules", ".git", "docs", "dist"]);
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || skip.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith(".malloy")) {
        const rel = path.relative(root, abs).split(path.sep).join("/");
        files[`file:///${rel}`] = fs.readFileSync(abs, "utf8");
      }
    }
  };
  walk(root);
  return files;
}

/** The model files reachable by following imports from `entries`.

    Table references must come from THIS set rather than from every .malloy in
    the project. A repo commonly keeps more than one storage binding — a
    gs.malloy pointing at GCS next to the one actually imported — and scanning
    all of them would put both sets of tables in the preload map, so the page
    would download a second full copy of data it already has. Leftover files
    should cost nothing. */
export function reachableModelFiles(
  modelFiles: Record<string, string>,
  entries: string[],
): Record<string, string> {
  // `import "x.malloy"` and `import { a, b } from './x.malloy'`.
  const IMPORT = /\bimport\s+(?:\{[^}]*\}\s+from\s+)?['"]([^'"]+)['"]/g;
  const out: Record<string, string> = {};
  const queue = entries.map((e) => `file:///${e.replace(/^\.?\//, "")}`);
  while (queue.length) {
    const key = queue.shift() as string;
    if (key in out) continue;
    const src = modelFiles[key];
    if (src == null) continue; // an import we don't have; the compiler reports it
    out[key] = src;
    const dir = key.slice(0, key.lastIndexOf("/"));
    for (const m of src.matchAll(IMPORT)) {
      queue.push(new URL(m[1], dir + "/").href); // resolve against the importer
    }
  }
  return out;
}

/** Every `table('…')` reference in the model, in declaration order, deduped. */
export function findTableRefs(modelFiles: Record<string, string>): string[] {
  const refs = new Set<string>();
  // `table('x')` / `table("x")`, with or without a connection prefix.
  const re = /\btable\(\s*(['"])([^'"]+)\1/g;
  for (const src of Object.values(modelFiles)) {
    for (const m of src.matchAll(re)) refs.add(m[2]);
  }
  return [...refs].sort();
}

/** A data FILE the published page has to fetch, as opposed to a warehouse table
    it can't. Two spellings qualify:
      - an absolute `http(s)://` URL, fetched as-is;
      - a path relative to the project root (`data/x.parquet`), which the build
        copies into the site and the page fetches same-origin.
    A warehouse reference like `md.table('db.schema.tbl')` is neither, and must
    NOT end up here — it isn't fetchable, and listing it would make the page try.
    The data-file extension is what separates the two. */
export function isDataFile(ref: string): boolean {
  if (/^https?:\/\//i.test(ref)) return true;
  return /\.(parquet|csv|tsv|json|ndjson)$/i.test(ref);
}

/** Where each data file the model reads has to come from, once published.
    `map` is what the page needs: table reference -> href to fetch. The KEY stays
    exactly what the model wrote, because that is the name DuckDB looks up — so
    the same model text works in VSCode, `dashboard dev`, and the published site.
    `copies` is what the build has to move.

    The href is always the file's path relative to the SITE ROOT. That gives two
    layouts for free:
      data/x.parquet  with --out docs  ->  ./data/x.parquet   (copied into docs/)
      docs/x.parquet  with --out docs  ->  ./x.parquet        (already there)
    The second is worth preferring when the site is committed: the file lives in
    git once instead of twice. */
export function tableFilePlan(
  modelFiles: Record<string, string>,
  outRel: string,
): { map: Record<string, string>; copies: string[] } {
  const map: Record<string, string> = {};
  const copies: string[] = [];
  const out = outRel.replace(/^\.?\//, "").replace(/\/$/, "");
  for (const ref of findTableRefs(modelFiles)) {
    if (!isDataFile(ref)) continue;
    if (/^https?:\/\//i.test(ref)) {
      map[ref] = ref;
      continue;
    }
    const rel = ref.replace(/^\.?\//, "");
    if (out && (rel === out || rel.startsWith(out + "/"))) {
      // Already inside the site — just rebase the name, nothing to copy.
      map[ref] = `./${rel.slice(out.length + 1)}`;
    } else {
      map[ref] = `./${rel}`;
      copies.push(rel);
    }
  }
  return { map, copies };
}

/** Copy the DuckDB-WASM binaries + workers next to the site. Self-hosting keeps
    the published site fully self-contained (no CDN dependency, works offline).
    Both bundles ship: selectBundle picks `eh` where WebAssembly exception
    handling is available and falls back to `mvp`. The multithreaded `coi`
    bundle is deliberately NOT shipped — it needs COOP/COEP headers, which
    GitHub Pages cannot send. */
function copyDuckDBAssets(outDir: string): string[] {
  const names = [
    "duckdb-mvp.wasm",
    "duckdb-eh.wasm",
    "duckdb-browser-mvp.worker.js",
    "duckdb-browser-eh.worker.js",
  ];
  const dir = path.join(outDir, "duckdb");
  fs.mkdirSync(dir, { recursive: true });
  const copied: string[] = [];
  for (const n of names) {
    // Resolve each asset by its own exported subpath. The package's "exports"
    // map deliberately does NOT expose ./package.json, so the usual
    // resolve-the-manifest-then-join trick throws ERR_PACKAGE_PATH_NOT_EXPORTED.
    const src = require.resolve(`@duckdb/duckdb-wasm/dist/${n}`);
    fs.copyFileSync(src, path.join(dir, n));
    copied.push(n);
  }
  return copied;
}


/** Link shape per target: sibling .html files for a plain static host, clean
    extensionless paths where the host rewrites them (vercel.json cleanUrls). */
function navFor(dash: Dashboard, all: Dashboard[], cleanUrls: boolean): string {
  return sharedNav(dash.name, all, (n) =>
    cleanUrls ? `./${encodeURIComponent(n)}` : `./${encodeURIComponent(n)}.html`,
  );
}

/** Google Analytics 4, injected into every emitted page's <head>.
    Returns "" when no id is configured, so the default build ships no
    third-party script and sets no cookies. */
function analyticsSnippet(id: string | undefined): string {
  if (!id) return "";
  const j = JSON.stringify(id);
  return (
    `<script async src="https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}"></script>\n` +
    `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}\n` +
    `gtag('js',new Date());gtag('config',${j});</script>`
  );
}

function page(
  dash: Dashboard,
  all: Dashboard[],
  title: string,
  givenSpecs: unknown[],
  tileSpecs: unknown[] | undefined,
  cleanUrls: boolean,
  analytics: string | undefined,
): string {
  const info = {
    name: dash.name,
    query: dash.query,
    title: dash.title,
    description: dash.description,
    entryFile: dash.entryFile,
    tiles: dash.tiles,
    tileSpecs,
    dashboard_columns: dash.dashboard_columns,
    givens: dash.givens,
    autorun: dash.autorun,
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(dash.title || dash.name)}${title ? ` · ${esc(title)}` : ""}</title>
<link rel="stylesheet" href="./assets/site.css">
${analyticsSnippet(analytics)}
</head>
<body>
${navFor(dash, all, cleanUrls)}
<div id="root"></div>
<script>
window.__DASHBOARD__ = ${JSON.stringify(info)};
// Given SPECS (label/type/default/suggest) are introspected from the model's
// given: declarations at BUILD time — the runtime reads them from here to draw
// controls and seed initial values. Without them there are no controls and
// every given starts empty.
window.__GIVENS__ = ${JSON.stringify(givenSpecs)};
// __INITIAL_GIVENS__ is NOT set here on purpose: the entry bundle sets it from
// location.search using shared/givens-url, the same encoder the dev server uses.
// An inline copy is what drifted last time (it stripped the dollar-sign prefix
// the runtime keys off, so every shareable link fell back to defaults).
</script>
<script src="./assets/model-files.js"></script>
<script type="module" src="./assets/${dash.name}.js"></script>
</body>
</html>
`;
}

/** The landing page. A repo can supply `dashboards/index.jsx` for a real
    written introduction; without one we emit a plain list of dashboards. The
    custom landing page is ordinary React — it needs no Malloy and no DuckDB, so
    it is bundled separately and stays tiny. */
function indexPage(
  dashboards: Dashboard[],
  title: string,
  custom: boolean,
  cleanUrls: boolean,
  analytics: string | undefined,
): string {
  const link = (n: string) => (cleanUrls ? `./${encodeURIComponent(n)}` : `./${encodeURIComponent(n)}.html`);
  const body = custom
    ? `<div id="root"></div>\n` +
      `<script>window.__DASHBOARDS__ = ${JSON.stringify(
        dashboards.map((d) => ({ name: d.name, title: d.title, description: d.description, href: link(d.name) })),
      )};</script>\n` +
      `<script type="module" src="./assets/index.js"></script>`
    : `<main class="index"><h1>${esc(title)}</h1><ul>` +
      dashboards
        .map(
          (d) =>
            `<li><a href="${link(d.name)}"><strong>${esc(d.title || d.name)}</strong>` +
            (d.description ? `<span>${esc(d.description)}</span>` : "") +
            `</a></li>`,
        )
        .join("") +
      `</ul></main>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="./assets/site.css">
${analyticsSnippet(analytics)}
</head>
<body>
${sharedNav("", dashboards, link)}
${body}
</body>
</html>
`;
}

const SITE_CSS = `:root{--bg:#fbfbfc;--fg:#16181d;--muted:#6b7280;--card:#fff;--line:#e4e6eb;--accent:#2a78d6}
@media(prefers-color-scheme:dark){:root{--bg:#14161a;--fg:#e8eaed;--muted:#9aa1ac;--card:#1c1f25;--line:#2c3038;--accent:#4f9bff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.index{max-width:760px;margin:0 auto;padding:48px 20px}
.index h1{font-size:22px;font-weight:650;margin:0 0 22px}
.index ul{list-style:none;padding:0;margin:0;display:grid;gap:10px}
.index a{display:flex;flex-direction:column;gap:3px;padding:16px 18px;border:1px solid var(--line);border-radius:12px;background:var(--card);text-decoration:none;color:inherit}
.index a:hover{border-color:var(--accent)}
.index span{font-size:13px;color:var(--muted)}
` + NAV_CSS;

/** Where the bundle is going. The ARTIFACT is the same for every target — same
    pages, same runtime, same model. Only the host adapter differs:
      pages  — GitHub Pages: .nojekyll, .html URLs, no headers possible, so
               single-threaded DuckDB only.
      vercel — vercel.json: clean URLs, cache headers, and (later) COOP/COEP for
               the multithreaded DuckDB build.
    A third target, warehouse-backed (`dashboard dev`'s run path deployed as a
    function), is the next rung: it swaps the browser DuckDB host for a fetch to
    /api/run and drops ~7.7 MB of wasm. */
export type BundleTarget = "pages" | "vercel";

export interface BundleOptions {
  root?: string;
  out?: string;
  title?: string;
  serve?: boolean;
  port?: number;
  target?: BundleTarget;
  /** "cdn" (default) references DuckDB from jsDelivr at the exact installed
      version — immutable, CORS-open, brotli-compressed (~6.8 MB vs 7.7 MB
      gzipped from a plain static host), and nothing lands in your repo.
      "bundled" copies the binaries into the output for a fully self-contained
      site that works offline and depends on no third party — at the cost of
      ~75 MB, which for a GitHub Pages deploy means 75 MB committed to git. */
  duckdb?: "cdn" | "bundled";
  /** GA4 Measurement ID (G-XXXXXXXXXX), overriding `malloyyo.analytics` in
      malloy-config.json. Normally set it in the config instead: it is a
      property of the project, not of one invocation, so every rebuild picks it
      up without anyone having to remember a flag. Neither set = no analytics,
      no third-party script, no cookies. */
  analytics?: string;
}

export async function bundleDashboards(opts: BundleOptions = {}): Promise<void> {
  const root = path.resolve(opts.root ?? process.cwd());
  const outDir = path.resolve(root, opts.out ?? "docs");
  const title = opts.title ?? path.basename(root);
  const target: BundleTarget = opts.target ?? "pages";
  // The flag wins so a one-off build can override, but the config is the
  // normal place — a site should not lose its analytics tag because someone
  // rebuilt without remembering the flag.
  const analytics = opts.analytics ?? readSiteConfig(root).analytics;
  // Only Vercel can rewrite extensionless paths, so only there do the nav links
  // drop `.html`. On a plain static host a clean URL would just 404.
  const cleanUrls = target === "vercel";
  const selfHostDuckdb = opts.duckdb === "bundled";

  const runner: ModelRunner = await makeRunner(root);
  const dashboards = await discoverDashboards(root, runner);
  if (dashboards.length === 0) throw new Error(`no dashboards found in ${path.join(root, "dashboards")}`);

  // Data files copied in by a PREVIOUS run are not predictable from this run's
  // model — if the data moved (data/ -> docs/), last run's copies are orphans
  // that nobody notices until they are committed. So the build records what it
  // copied and removes anything it no longer needs. Same failure as the stale
  // esbuild chunks below, one directory over.
  const manifestPath = path.join(outDir, ".bundle-manifest.json");
  let priorData: string[] = [];
  try {
    priorData = JSON.parse(fs.readFileSync(manifestPath, "utf8")).dataFiles ?? [];
  } catch {
    /* no manifest yet */
  }

  // Clear what we generate before regenerating it. esbuild hashes chunk names,
  // so without this every run leaves the previous run's chunks behind — dead
  // weight that then gets committed and served. Scoped to our own outputs so a
  // hand-added CNAME or README in docs/ survives.
  for (const sub of ["assets", "duckdb"]) {
    fs.rmSync(path.join(outDir, sub), { recursive: true, force: true });
  }
  if (fs.existsSync(outDir)) {
    for (const f of fs.readdirSync(outDir)) {
      if (f.endsWith(".html")) fs.rmSync(path.join(outDir, f), { force: true });
    }
  }

  fs.mkdirSync(path.join(outDir, "assets"), { recursive: true });

  if (target === "pages") {
    // Jekyll silently drops paths beginning with an underscore, which bundlers
    // emit more often than you'd like. GitHub Pages skips Jekyll entirely if
    // this file exists.
    fs.writeFileSync(path.join(outDir, ".nojekyll"), "");
  } else {
    fs.rmSync(path.join(outDir, ".nojekyll"), { force: true });
    // The one thing Vercel can do that Pages cannot: send headers. Clean URLs
    // drop the .html; the wasm gets a long immutable cache (it only changes when
    // DuckDB does, and it is ~90% of first load).
    fs.writeFileSync(
      path.join(outDir, "vercel.json"),
      JSON.stringify(
        {
          $schema: "https://openapi.vercel.sh/vercel.json",
          cleanUrls: true,
          headers: [
            {
              source: "/duckdb/(.*)",
              headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
            },
            {
              source: "/assets/(.*)",
              headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
            },
          ],
        },
        null,
        2,
      ) + "\n",
    );
  }

  const modelFiles = inlineModelFiles(root);
  // Copy every project-relative data file into the site, preserving its path, so
  // the page can fetch it SAME-ORIGIN — no CORS to configure at all. Absolute
  // URLs are left alone and fetched cross-origin (which needs CORS on that host).
  const outRel = path.relative(root, outDir).split(path.sep).join("/");
  // Only what the dashboards actually import — see reachableModelFiles.
  const usedFiles = reachableModelFiles(
    modelFiles,
    dashboards.map((d) => d.entryFile).filter((f): f is string => !!f),
  );
  const { map: tableFiles, copies } = tableFilePlan(usedFiles, outRel);
  for (const rel of copies) {
    const from = path.join(root, rel);
    if (!fs.existsSync(from)) {
      throw new Error(
        `model reads '${rel}' but ${from} does not exist.\n` +
          `Data files are referenced by a path relative to the project root.`,
      );
    }
    const to = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  const copiedData = copies;

  for (const stale of priorData) {
    if (copies.includes(stale)) continue;
    fs.rmSync(path.join(outDir, stale), { force: true });
    // Tidy any directory the orphan left behind, but never anything with
    // content still in it.
    try {
      fs.rmdirSync(path.dirname(path.join(outDir, stale)));
    } catch {
      /* not empty, or the site root */
    }
    console.log(`  removed stale ${stale}`);
  }
  fs.writeFileSync(manifestPath, JSON.stringify({ dataFiles: copies }, null, 2) + "\n");

  fs.writeFileSync(
    path.join(outDir, "assets", "model-files.js"),
    `window.__MODEL_FILES__ = ${JSON.stringify(modelFiles)};\n` +
      `window.__TABLE_FILES__ = ${JSON.stringify(tableFiles)};\n` +
      (selfHostDuckdb ? `window.__DUCKDB_BASE__ = "./duckdb/";\n` : ""),
  );

  // A repo may ship `dashboards/index.jsx|tsx` as a written landing page.
  const landing = ["jsx", "tsx"]
    .map((ext) => path.join(root, "dashboards", `index.${ext}`))
    .find((f) => fs.existsSync(f));

  const runtimeDir = resolveRuntimeDir();
  const runtimeIndex = path.join(runtimeDir, "index.ts");
  const wasmEntry = path.join(runtimeDir, "..", "frame-wasm-entry.tsx");

  // One entry point per dashboard, with code splitting on: Malloy's compiler and
  // the DuckDB wrapper are the bulk of the payload and identical across
  // dashboards, so esbuild factors them into a shared chunk that the browser
  // caches once instead of per page.
  //
  // Each entry is GENERATED (namespace `vdash`) rather than reusing one file:
  // esbuild resolves a given import specifier once per build, so N entries all
  // pointing at the same source could never resolve `virtual:dashboard` to N
  // different components. The generated stub names its component directly.
  const byEntry = new Map(dashboards.map((d) => [`vdash:${d.name}`, d]));

  await esbuild.build({
    entryPoints: Object.fromEntries(dashboards.map((d) => [d.name, `vdash:${d.name}`])),
    bundle: true,
    splitting: true,
    format: "esm",
    outdir: path.join(outDir, "assets"),
    minify: true,
    logLevel: "warning",
    ...browserBuildBase(),
    plugins: [
      {
        name: "virtual-dashboard-per-entry",
        setup(b) {
          b.onResolve({ filter: /^vdash:/ }, (args) => ({ path: args.path, namespace: "vdash" }));
          b.onLoad({ filter: /.*/, namespace: "vdash" }, (args) => {
            const dash = byEntry.get(args.path);
            if (!dash) throw new Error(`no dashboard for entry ${args.path}`);
            // A tag-only dashboard has no component; boot(null) makes
            // mountStatic fall back to the Malloy renderer.
            const imp = dash.tsxPath
              ? `import Dashboard from ${JSON.stringify(dash.tsxPath)};`
              : `const Dashboard = null;`;
            return {
              contents: `${imp}\nimport { boot } from ${JSON.stringify(wasmEntry)};\nboot(Dashboard);\n`,
              loader: "js",
              // Resolve the component's own imports (react, @malloyyo/dashboard)
              // from the model repo's directory, matching `dashboard dev`.
              resolveDir: path.dirname(dash.tsxPath ?? path.join(root, "dashboards", "x")),
            };
          });
          b.onResolve({ filter: /^@malloyyo\/dashboard$/ }, () => ({ path: runtimeIndex }));
        },
      },
      hostAliasPlugin,
    ],
  });

  fs.writeFileSync(path.join(outDir, "assets", "site.css"), SITE_CSS);

  // Introspect each dashboard's given specs from the model — the same call the
  // dev server makes per page load (resolveGivens), done once at build time.
  for (const d of dashboards) {
    let specs: unknown[] = [];
    let tileSpecs: unknown[] | undefined;
    if (d.tiles && d.entryFile) {
      const t = await runner.dashboardTiles(d.entryFile, d.tiles);
      specs = t.union;
      tileSpecs = t.tiles;
    } else {
      const got = d.entryFile
        ? await runner.givensForQueryIn(d.entryFile, d.query)
        : await runner.givensForQuery(d.query);
      if (!got.ok) throw new Error(`dashboard ${d.name}: ${got.error}`);
      specs = got.givens;
    }
    fs.writeFileSync(path.join(outDir, `${d.name}.html`), page(d, dashboards, title, specs, tileSpecs, cleanUrls, analytics));
  }
  fs.writeFileSync(path.join(outDir, "index.html"), indexPage(dashboards, title, !!landing, cleanUrls, analytics));

  if (landing) {
    // Deliberately its OWN esbuild pass, not an entry in the dashboard build:
    // sharing that build would pull Malloy, DuckDB and the renderer into the
    // landing page's chunk. It is React and nothing else.
    await esbuild.build({
      stdin: {
        contents:
          `import React from "react";\nimport { createRoot } from "react-dom/client";\n` +
          `import Landing from ${JSON.stringify(landing)};\n` +
          `createRoot(document.getElementById("root")).render(React.createElement(Landing, ` +
          `{ dashboards: window.__DASHBOARDS__ || [] }));\n`,
        resolveDir: path.dirname(landing),
        loader: "js",
      },
      bundle: true,
      format: "esm",
      minify: true,
      outfile: path.join(outDir, "assets", "index.js"),
      logLevel: "warning",
      // Same base as the dashboard pass. A landing page needs no Malloy today,
      // but one that imported anything reaching antlr4ts would otherwise die at
      // load with "process is not defined" from the util polyfill.
      ...browserBuildBase(),
      plugins: [hostAliasPlugin],
    });
  }

  const duck = selfHostDuckdb ? copyDuckDBAssets(outDir) : [];
  if (!selfHostDuckdb) fs.rmSync(path.join(outDir, "duckdb"), { recursive: true, force: true });

  const bytes = (p: string) => fs.statSync(p).size;
  const assetDir = path.join(outDir, "assets");
  const jsTotal = fs
    .readdirSync(assetDir)
    .filter((f) => f.endsWith(".js"))
    .reduce((a, f) => a + bytes(path.join(assetDir, f)), 0);

  console.log(`\nbundled ${dashboards.length} dashboard(s) → ${path.relative(process.cwd(), outDir) || "."}/`);
  for (const d of dashboards) console.log(`  ${d.name}.html   ${d.title ?? ""}`);
  console.log(`\n  js         ${(jsTotal / 1048576).toFixed(2)} MB`);
  console.log(
    selfHostDuckdb
      ? `  duckdb     ${duck.length} assets (self-hosted)`
      : `  duckdb     jsDelivr CDN (nothing copied)`,
  );
  console.log(`  model      ${Object.keys(modelFiles).length} .malloy files inlined`);
  if (analytics) console.log(`  analytics  ${analytics}`);
  if (copiedData.length) {
    const mb = copiedData.reduce((a, r) => a + fs.statSync(path.join(root, r)).size, 0) / 1048576;
    console.log(`  data       ${copiedData.length} file(s) copied, ${mb.toFixed(1)} MB (same-origin)`);
  }
  console.log(
    target === "pages"
      ? `\nPublish: commit ${path.basename(outDir)}/ and point GitHub Pages at it.`
      : `\nPublish: deploy ${path.basename(outDir)}/ to Vercel (vercel.json written: clean URLs + asset caching).`,
  );

  if (opts.serve !== false) {
    await serveStatic(outDir, opts.port ?? 4180);
    // Hold the process open — serveStatic resolves once listening.
    await new Promise<never>(() => {});
  }
}
