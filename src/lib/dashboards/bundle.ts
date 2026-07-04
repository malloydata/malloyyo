// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Compile a stored Dashboard.tsx into a browser IIFE at request time. The heavy
// libs (React, ReactDOM, the Malloy renderer) are NOT bundled here — they come
// from the prebuilt vendor bundle (window.__DASH_VENDOR__, see
// scripts/build-dashboard-vendor.mjs). So this runtime bundle resolves nothing
// from node_modules: `react` is shimmed to the vendor global, JSX compiles to
// React.createElement (classic), and the only inputs are the frame runtime + the
// artifact source. That keeps it reliable in a traced serverless function.

import * as esbuild from "esbuild";
import { createHash } from "node:crypto";
import { FRAME_SOURCE } from "./frame-source";

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

const cache = new Map<string, string>();

export async function bundleDashboard(source: string): Promise<string> {
  // Key on the frame runtime too, so a frame-source change rebuilds cached bundles.
  const key = createHash("sha256").update(FRAME_SOURCE).update("\0").update(source).digest("hex");
  const hit = cache.get(key);
  if (hit) return hit;

  const result = await esbuild.build({
    stdin: { contents: FRAME_SOURCE, resolveDir: process.cwd(), loader: "tsx", sourcefile: "frame-entry.tsx" },
    bundle: true,
    format: "iife",
    platform: "browser",
    // Classic JSX so no react/jsx-runtime import — React comes from the shim.
    jsx: "transform",
    jsxFactory: "React.createElement",
    jsxFragment: "React.Fragment",
    write: false,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "dashboard",
        setup(b) {
          b.onResolve({ filter: /^virtual:dashboard$/ }, () => ({ path: "dashboard", namespace: "vdash" }));
          b.onLoad({ filter: /.*/, namespace: "vdash" }, () => ({ contents: source, loader: "tsx" }));
          // `react` / `react/...` → the vendor global. Nothing heavy is bundled.
          b.onResolve({ filter: /^react($|\/)/ }, () => ({ path: "react", namespace: "vreact" }));
          b.onLoad({ filter: /.*/, namespace: "vreact" }, () => ({ contents: REACT_SHIM, loader: "js" }));
        },
      },
    ],
  });
  const js = result.outputFiles[0].text;
  cache.set(key, js);
  return js;
}
