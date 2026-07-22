// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Compile a stored Dashboard.tsx into a browser IIFE at request time. The frame
// RUNTIME and heavy libs (React, ReactDOM, the Malloy renderer, filter parser)
// are NOT bundled here — they ship in the prebuilt vendor asset
// (window.__DASH_VENDOR__ / window.__DASH_RUNTIME__, see
// scripts/build-dashboard-vendor.mjs, which bundles the SAME
// packages/cli/src/frame-runtime the CLI dev preview uses). So this runtime
// bundle resolves nothing from node_modules: `react` and `@malloyyo/dashboard`
// are shimmed to the vendor globals, and the only real input is the artifact
// source. That keeps it reliable in a traced serverless function.
//
// An empty `source` means the `# artifact` tag ships no custom component —
// mount the runtime's default dashboard.

import * as esbuild from "esbuild";
import { createHash } from "node:crypto";

// The frame entry: mount whatever virtual:dashboard resolves to (null = the
// runtime's DefaultDashboard).
const ENTRY_SOURCE = `
import Dashboard from "virtual:dashboard";
window.__DASH_RUNTIME__.mountDashboard(Dashboard);
`;

// `import React from "react"` (and named hooks) → the vendor global. Covers the
// common imports a Dashboard.tsx uses; anything else is a lint-worthy smell.
const REACT_SHIM = `
const R = window.__DASH_VENDOR__.React;
export default R;
export const useState = R.useState, useEffect = R.useEffect, useRef = R.useRef,
  useMemo = R.useMemo, useCallback = R.useCallback, useReducer = R.useReducer,
  Fragment = R.Fragment, Component = R.Component, createElement = R.createElement,
  memo = R.memo;
`;

// Automatic JSX (matching the CLI preview) imports react/jsx-runtime, so a
// Dashboard.tsx that doesn't `import React` still works.
const JSX_SHIM = `
const J = window.__DASH_VENDOR__.jsxRuntime;
export const jsx = J.jsx, jsxs = J.jsxs, Fragment = J.Fragment;
`;

// `import { Controls, useGiven, … } from "@malloyyo/dashboard"` → the runtime
// bundled in the vendor asset. Explicit re-exports (not export*) because the
// shim's exports must be static for esbuild.
//
// A custom dashboard renders ITSELF (VegaChart + its own React), so the Malloy
// renderer surface — Panel / CompositeDashboard / DefaultDashboard — is
// deliberately absent here. Importing one from a Dashboard.tsx fails the bundle
// with "No matching export": the signal to make it tag-only (which renders
// full-width in the trusted page) or draw it with VegaChart.
// MUST re-export every name `packages/cli/src/frame-runtime/index.ts` exports.
// The vendor build puts that module's whole namespace on window.__DASH_RUNTIME__,
// so anything missing HERE still exists at runtime but can't be imported: esbuild
// needs the names statically, and a dashboard importing one that's absent fails
// to bundle with "No matching export in vruntime:runtime" — at VIEW time, in
// production only (the CLI preview aliases to the real source, so it works
// locally, and `lint` transpiles without resolving imports, so it passes too).
// `dashboard-runtime-shim.test.ts` fails if this list drifts. Keep it complete.
const RUNTIME_SHIM = `
const D = window.__DASH_RUNTIME__;
export const filters = D.filters, runData = D.runData,
  useGiven = D.useGiven, useOptions = D.useOptions, useQuery = D.useQuery,
  mount = D.mount, setHost = D.setHost,
  mountDashboard = D.mountDashboard, mountInPage = D.mountInPage,
  dashboardInfo = D.dashboardInfo, givenSpecs = D.givenSpecs,
  Controls = D.Controls, Given = D.Given, Select = D.Select, Search = D.Search,
  MultiSelect = D.MultiSelect, Range = D.Range, Checkbox = D.Checkbox,
  TimeRange = D.TimeRange, DEFAULT_TIME_PRESETS = D.DEFAULT_TIME_PRESETS,
  Field = D.Field, VegaChart = D.VegaChart;
export default D;
`;

const cache = new Map<string, string>();

export async function bundleDashboard(source: string): Promise<string> {
  const key = createHash("sha256").update(ENTRY_SOURCE).update("\0").update(source).digest("hex");
  const hit = cache.get(key);
  if (hit) return hit;

  const custom = source.trim().length > 0;
  const result = await esbuild.build({
    stdin: { contents: ENTRY_SOURCE, resolveDir: process.cwd(), loader: "ts", sourcefile: "frame-entry.ts" },
    bundle: true,
    format: "iife",
    platform: "browser",
    // Automatic JSX (like the CLI preview) — no `import React` required in a
    // Dashboard.tsx; the injected react/jsx-runtime import is shimmed below.
    jsx: "automatic",
    write: false,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "dashboard",
        setup(b) {
          b.onResolve({ filter: /^virtual:dashboard$/ }, () => ({ path: "dashboard", namespace: "vdash" }));
          b.onLoad({ filter: /.*/, namespace: "vdash" }, () => ({
            contents: custom ? source : "export default null;",
            loader: "tsx",
          }));
          // @malloyyo/dashboard → the vendor-bundled frame runtime.
          b.onResolve({ filter: /^@malloyyo\/dashboard$/ }, () => ({ path: "runtime", namespace: "vruntime" }));
          b.onLoad({ filter: /.*/, namespace: "vruntime" }, () => ({ contents: RUNTIME_SHIM, loader: "js" }));
          // react/jsx-runtime (automatic JSX) → vendor's jsx runtime.
          b.onResolve({ filter: /^react\/jsx-(dev-)?runtime$/ }, () => ({ path: "jsxr", namespace: "vjsx" }));
          b.onLoad({ filter: /.*/, namespace: "vjsx" }, () => ({ contents: JSX_SHIM, loader: "js" }));
          // `import React from "react"` (and named hooks) → the vendor global.
          b.onResolve({ filter: /^react$/ }, () => ({ path: "react", namespace: "vreact" }));
          b.onLoad({ filter: /.*/, namespace: "vreact" }, () => ({ contents: REACT_SHIM, loader: "js" }));
        },
      },
    ],
  });
  const js = result.outputFiles[0].text;
  cache.set(key, js);
  return js;
}
