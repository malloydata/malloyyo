// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Build the dashboard "vendor" bundle: React + ReactDOM + the Malloy renderer +
// filter parser + THE FRAME RUNTIME (packages/cli/src/frame-runtime — the one
// implementation the CLI dev preview also bundles from source), built ONCE at
// build time (where all their transitive deps exist) into a static asset the
// sandboxed iframe loads. The per-dashboard bundle (compiled at request time)
// treats these as externals via window globals, so the runtime esbuild never
// has to resolve anything from node_modules in a traced serverless function:
//   window.__DASH_VENDOR__  — react/jsx/renderer, for the artifact's own imports
//   window.__DASH_RUNTIME__ — the frame runtime module (mountDashboard, Panel,
//                             Controls, hooks, filters …), what the artifact's
//                             `@malloyyo/dashboard` imports shim to
// See src/lib/dashboards/bundle.ts.

import * as esbuild from "esbuild";

const ENTRY = `
import * as React from "react";
import { createRoot } from "react-dom/client";
import { MalloyRenderer } from "@malloydata/render";
import * as jsxRuntime from "react/jsx-runtime";
import * as dashRuntime from "./packages/cli/src/frame-runtime/index.ts";
window.__DASH_VENDOR__ = { React, createRoot, MalloyRenderer, jsxRuntime };
window.__DASH_RUNTIME__ = dashRuntime;
`;

await esbuild.build({
  stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "ts", sourcefile: "vendor.ts" },
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  outfile: "public/dashboard-vendor.js",
  loader: { ".css": "empty" },
  define: { "process.env.NODE_ENV": '"production"' },
  minify: true,
  logLevel: "info",
});

console.log("✓ built public/dashboard-vendor.js");
