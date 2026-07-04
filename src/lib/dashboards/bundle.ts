// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Bundle a stored Dashboard.tsx into a browser IIFE at request time. The
// artifact source comes from the DB (a string), so the frame runtime is the
// esbuild entry (via stdin) and the dashboard is a virtual module. react /
// react-dom / @malloydata/render are forced to the app's own copies so a
// dashboard authored anywhere resolves them.

import * as esbuild from "esbuild";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { FRAME_SOURCE } from "./frame-source";

// Anchor resolution at the app root's real package.json, NOT import.meta.url —
// inside a Next route, import.meta.url resolves `react` to Next's vendored RSC
// build (a virtual [project]/… path, and the wrong React for a browser bundle).
// A cwd-anchored require does plain node resolution against the real node_modules.
const require = createRequire(resolve("package.json"));
const HOST_LIBS = [
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "@malloydata/render",
];
const HOST_ALIAS: Record<string, string> = {};
for (const spec of HOST_LIBS) {
  try {
    HOST_ALIAS[spec] = require.resolve(spec);
  } catch {
    /* optional */
  }
}

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
    jsx: "automatic",
    write: false,
    logLevel: "silent",
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "dashboard",
        setup(b) {
          b.onResolve({ filter: /^virtual:dashboard$/ }, () => ({ path: "dashboard", namespace: "vdash" }));
          b.onLoad({ filter: /.*/, namespace: "vdash" }, () => ({
            contents: source,
            loader: "tsx",
            resolveDir: process.cwd(),
          }));
          b.onResolve({ filter: /^(react($|\/)|react-dom($|\/)|@malloydata\/render$)/ }, (args) =>
            HOST_ALIAS[args.path] ? { path: HOST_ALIAS[args.path] } : undefined,
          );
        },
      },
    ],
  });
  const js = result.outputFiles[0].text;
  cache.set(key, js);
  return js;
}
