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
import { readFile } from "node:fs/promises";

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

// The bundle is minified, so every identifier the runtime defines gets
// renamed. One of its own helper names surviving as a CALL means the bundle
// references something it never defines — which is what `export { x } from
// "./m"` produces when the module also CALLS x: the name reaches consumers,
// the local scope keeps nothing, and the dashboard dies at runtime with "x is
// not defined". Shipped once; caught in production rather than by a test,
// because nothing here executes the bundle.
const built = await readFile("public/dashboard-vendor.js", "utf8");
const unresolved = ["asRunText", "runQuery", "runData", "combineTiles"].filter((name) =>
  new RegExp(`\\b${name}\\(`).test(built),
);
if (unresolved.length > 0) {
  console.error(
    `✗ dashboard-vendor.js calls ${unresolved.join(", ")} but never defines ${unresolved.length > 1 ? "them" : "it"} — ` +
      "a module re-exports the name instead of importing it.",
  );
  process.exit(1);
}

console.log("✓ built public/dashboard-vendor.js");
