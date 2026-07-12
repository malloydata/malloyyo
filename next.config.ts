// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit .next/standalone (minimal server + traced node_modules) for the Docker image.
  output: "standalone",
  async rewrites() {
    return [
      { source: "/.well-known/oauth-authorization-server", destination: "/api/oauth/discovery/authorization-server" },
      { source: "/.well-known/oauth-protected-resource", destination: "/api/oauth/discovery/protected-resource" },
    ];
  },
  serverExternalPackages: [
    "@duckdb/node-api",
    "@duckdb/node-bindings",
    // esbuild ships a native binary + dynamic requires; let it stay external so
    // Turbopack doesn't try to bundle it (used to compile dashboard artifacts).
    "esbuild",
  ],
  outputFileTracingIncludes: {
    "/mcp": [
      "./node_modules/@duckdb/node-bindings*/**/*",
    ],
    "/api/datasets": [
      "./node_modules/@duckdb/node-bindings*/**/*",
    ],
    "/api/datasets/[id]/model": [
      "./node_modules/@duckdb/node-bindings*/**/*",
    ],
    "/api/datasets/[id]/model/compile": [
      "./node_modules/@duckdb/node-bindings*/**/*",
    ],
    "/api/datasets/[id]/model/github": [
      "./node_modules/@duckdb/node-bindings*/**/*",
    ],
    "/api/datasets/[id]/webhook/github": [
      "./node_modules/@duckdb/node-bindings*/**/*",
    ],
    "/api/run": [
      "./node_modules/@duckdb/node-bindings*/**/*",
    ],
    // The dashboard bundle route runs esbuild at request time (to compile the
    // frame runtime + the artifact) — trace esbuild's binary in. React and the
    // renderer are NOT bundled at runtime (they come from the prebuilt
    // public/dashboard-vendor.js), so they don't need tracing here.
    "/api/dashboards/[datasetId]/[name]/bundle": [
      "./node_modules/esbuild/**",
      "./node_modules/@esbuild/**",
    ],
  },
};

export default nextConfig;
