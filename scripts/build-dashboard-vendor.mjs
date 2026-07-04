// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Build the dashboard "vendor" bundle: React + ReactDOM + the Malloy renderer,
// bundled ONCE at build time (where all their transitive deps exist) into a
// static asset the sandboxed iframe loads. The per-dashboard bundle (compiled at
// request time) then treats these as externals via `window.__DASH_VENDOR__`, so
// the runtime esbuild never has to resolve the heavy renderer in a traced
// serverless function. See src/lib/dashboards/bundle.ts.

import * as esbuild from "esbuild";

const ENTRY = `
import * as React from "react";
import { createRoot } from "react-dom/client";
import { MalloyRenderer } from "@malloydata/render";
window.__DASH_VENDOR__ = { React, createRoot, MalloyRenderer };
`;

await esbuild.build({
  stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: "ts", sourcefile: "vendor.ts" },
  bundle: true,
  format: "iife",
  platform: "browser",
  outfile: "public/dashboard-vendor.js",
  loader: { ".css": "empty" },
  define: { "process.env.NODE_ENV": '"production"' },
  minify: true,
  logLevel: "info",
});

console.log("✓ built public/dashboard-vendor.js");
