// Dashboard discovery and the browser-bundle settings every host shares.
//
// Split out of dashboard.ts so `bundle` does not have to import the dev SERVER
// to find dashboards: both hosts need discovery, only one needs an http server.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as esbuild from "esbuild";
import type { ModelRunner } from "./host.js";

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
export interface Dashboard {
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

/** Runtime source files, resolved whether we're running from src/ (tsx dev),
    the built dist/ (published install — copy-frame-src.mjs ships it alongside
    index.js), or a built dist/ next to a sibling src/ (local checkout). */
export function resolveRuntimeDir(): string {
  const candidates = [
    new URL("./frame-runtime/", import.meta.url), // src/dashboard.ts (tsx) OR dist/index.js (published)
    new URL("../src/frame-runtime/", import.meta.url), // built dist/ next to sibling src/ (checkout)
  ].map((u) => fileURLToPath(u));
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) {
    throw new Error(
      "frame-runtime/ not found next to the CLI (looked in ./frame-runtime and " +
        "../src/frame-runtime). A published install should ship it in dist/; " +
        "reinstall the CLI, or rebuild with `npm run build`.",
    );
  }
  return found;
}

/** esbuild plugin: force react / renderer / filter-parser imports to the CLI's
    OWN copies, whatever directory the (possibly external) model repo lives in. */
export const hostAliasPlugin: esbuild.Plugin = {
  name: "host-alias",
  setup(b) {
    b.onResolve(
      { filter: /^(react($|\/)|react-dom($|\/)|@malloydata\/(render|malloy-filter)$)/ },
      (args) => (HOST_ALIAS[args.path] ? { path: HOST_ALIAS[args.path] } : undefined),
    );
  },
};

/** Structure v2: each `dashboards/<name>.malloy` is one dashboard, compiled AS
    its own entry to read its `## artifact`. The optional custom component is a
    flat sibling `dashboards/<name>.jsx` (or .tsx). A `.malloy` with no
    `## artifact` is skipped (e.g. a shared include). */
export async function discoverDashboards(root: string, runner: ModelRunner): Promise<Dashboard[]> {
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
  // The written front door goes FIRST — it is the introduction, and `dashboard
  // dev` serves the first dashboard at `/`.
  //
  // Added after the loop, and only if nothing already answers to its name. A
  // `## artifact { name="index" }` tag on any other file resolves to the same
  // name, and two dashboards sharing one name shadow each other silently
  // (`pick()` takes the first, the bundle writes one page over the other). The
  // real dashboard wins — it has a query and a page; the About page yields.
  const about = aboutPage(root);
  if (about && !dashboards.some((d) => d.name === about.name)) dashboards.unshift(about);
  return dashboards;
}


/** esbuild settings shared by EVERY browser bundle this CLI emits (the dev
    server's frame, each static dashboard, the static landing page). Kept in one
    place because the pieces below are not optional-nice-to-haves: without the
    aliases, antlr4ts resolves `assert`/`util` to npm polyfills that reference
    `process` and throw at load; without the banner, a few `process` refs inside
    CJS wrappers do the same. A second build that forgot them would fail only at
    runtime, in the browser, with a stack trace pointing at util.js. */
export function browserBuildBase(): Pick<
  esbuild.BuildOptions,
  "platform" | "jsx" | "loader" | "define" | "alias" | "banner"
> {
  const shims = path.join(resolveRuntimeDir(), "..", "shims");
  return {
    platform: "browser",
    jsx: "automatic",
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"production"' },
    alias: {
      assert: path.join(shims, "assert.cjs"),
      util: path.join(shims, "util.cjs"),
    },
    banner: {
      js: "globalThis.process||={env:{},platform:'browser',versions:{},argv:[],cwd:()=>'/'};",
    },
  };
}

/** The name and title an About page gets when the repo ships no `index.malloy`.
    "index" matches the file it comes from and the `index.html` the bundle already
    emits for it; "About" is what a reader sees. */
export const ABOUT_NAME = "index";
export const ABOUT_TITLE = "About";

/**
 * The repo's written front door: `dashboards/index.jsx|tsx` with no
 * `index.malloy` beside it.
 *
 * It is a dashboard in every way that matters — repo-authored React, rendered by
 * the same runtime, in the same sandbox — except that it runs no query. Until now
 * only `bundle` knew about it (as a hardcoded filename), so the page an author
 * wrote to explain their data was invisible on the dev server and never even
 * uploaded by `publish`. Returning it here puts it in front of every surface at
 * once, FIRST, because it is the introduction: `dashboard dev` picks the first
 * dashboard for `/`, and the nav lists them in order.
 *
 * `query: ""` with no `tiles` is the marker for "renders no data". Nothing
 * downstream should introspect givens for it — there is no query to introspect.
 *
 * An `index.malloy` that DOES exist wins: that is an ordinary dashboard named
 * "index", discovered by the loop above, and this returns null so it is not
 * shadowed by a second entry of the same name.
 */
export function aboutPage(root: string): Dashboard | null {
  const dir = path.join(root, "dashboards");
  if (fs.existsSync(path.join(dir, "index.malloy"))) return null;
  const component = ["jsx", "tsx"]
    .map((ext) => path.join(dir, `index.${ext}`))
    .find((p) => fs.existsSync(p));
  if (!component) return null;
  return { name: ABOUT_NAME, query: "", title: ABOUT_TITLE, tsxPath: component };
}

/** True for a dashboard that renders no data — the About page today. Callers use
    it to skip given introspection and query compilation, both of which need a
    query that by definition isn't there. */
export const rendersNoData = (d: Pick<Dashboard, "query" | "tiles">): boolean =>
  !d.query && (!d.tiles || d.tiles.length === 0);
