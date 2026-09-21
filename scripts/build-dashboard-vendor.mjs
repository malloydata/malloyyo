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
import { readFile, writeFile } from "node:fs/promises";
import vm from "node:vm";

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

// ── public/mcp-app-sdk.js ───────────────────────────────────────────────────
//
// The ext-apps client SDK, the second script an MCP App panel loads. It ships
// as an ES module; the panel loads it as a CLASSIC script (a cross-origin
// `type="module"` needs CORS, a classic one doesn't), so the trailing export
// statement is rewritten onto a global the panel's loader reads.
//
// Both of these are static assets rather than markup inlined into the panel
// resource on purpose: a `resources/read` carrying 4.6 MB of runtime is a 5 MB
// JSON-RPC message, which is over Vercel's 4.5 MB function-response limit and
// past what a host will accept — the panel then never loads at all. The ext
// spec's own guidance is to serve bundled JS from your origin and declare it
// in `_meta.ui.csp.resourceDomains`, which src/lib/mcp-app-panel.ts does.
const SDK_SRC = "node_modules/@modelcontextprotocol/ext-apps/dist/src/app-with-deps.js";
const sdkRaw = await readFile(SDK_SRC, "utf8");
const exports_ = /export\s*\{([^}]*)\}\s*;?\s*$/.exec(sdkRaw);
if (!exports_) {
  console.error(`✗ ${SDK_SRC}: no trailing export statement to rewrite`);
  process.exit(1);
}
const globals = exports_[1]
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean)
  .map((x) => {
    const [local, , exported] = x.split(/\s+/);
    return `${JSON.stringify(exported ?? local)}: ${local}`;
  })
  .join(", ");
const sdkClassic = sdkRaw.slice(0, exports_.index) + `globalThis.__EXT_APPS__ = {${globals}};\n`;

// Parse it as a classic script here, where the build can still fail, rather
// than discovering in a panel that some other module syntax survived.
try {
  new vm.Script(sdkClassic, { filename: "mcp-app-sdk.js" });
} catch (e) {
  console.error(`✗ mcp-app-sdk.js is not valid as a classic script: ${e.message}`);
  process.exit(1);
}

await writeFile("public/mcp-app-sdk.js", sdkClassic);
console.log("✓ built public/mcp-app-sdk.js");
