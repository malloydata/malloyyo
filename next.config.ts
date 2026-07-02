// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import type { NextConfig } from "next";

// Files every DuckDB-using route needs traced into its function bundle: the
// native bindings, plus the pre-fetched extensions (scripts/fetch-duckdb-
// extensions.mjs) so cold instances LOAD httpfs locally instead of downloading
// ~22 MB from extensions.duckdb.org. See src/lib/malloy.ts (BUNDLED_EXTENSION_DIR).
const DUCKDB_TRACE_INCLUDES = [
  "./node_modules/@duckdb/node-bindings*/**/*",
  "./duckdb-extensions/**/*",
];

const DUCKDB_ROUTES = [
  "/mcp",
  "/api/datasets",
  "/api/datasets/[id]/model",
  "/api/datasets/[id]/model/compile",
  "/api/datasets/[id]/model/github",
  "/api/datasets/[id]/webhook/github",
  "/api/run",
];

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
  ],
  outputFileTracingIncludes: Object.fromEntries(
    DUCKDB_ROUTES.map((route) => [route, DUCKDB_TRACE_INCLUDES]),
  ),
};

export default nextConfig;
