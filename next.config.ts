// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
  },
};

export default nextConfig;
