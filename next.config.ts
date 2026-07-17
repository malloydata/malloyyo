// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit .next/standalone (minimal server + traced node_modules) for the Docker image.
  output: "standalone",
  async rewrites() {
    // Serve the discovery metadata at both the bare well-known path (older MCP
    // spec, 2025-03-26) AND the resource-scoped path variant. Current Claude
    // clients follow RFC 9728 / RFC 8414: for a resource served under a path
    // (ours is /mcp) they insert the well-known segment *before* the path and
    // fetch e.g. /.well-known/oauth-protected-resource/mcp. Without the :path*
    // rewrites those 404, discovery fails, and OAuth never completes. The route
    // handlers derive `resource`/`authorization_servers` from the origin, so the
    // same handler returns the correct body for either form.
    return [
      { source: "/.well-known/oauth-authorization-server", destination: "/api/oauth/discovery/authorization-server" },
      { source: "/.well-known/oauth-authorization-server/:path*", destination: "/api/oauth/discovery/authorization-server" },
      { source: "/.well-known/oauth-protected-resource", destination: "/api/oauth/discovery/protected-resource" },
      { source: "/.well-known/oauth-protected-resource/:path*", destination: "/api/oauth/discovery/protected-resource" },
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
