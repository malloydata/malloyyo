import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  // Only the native-binding packages need to stay external. Everything else
  // (Malloy, AI SDK, AWS SDK) can be bundled and tree-shaken — including
  // them as `serverExternalPackages` was forcing the entire node_modules
  // tree into every Vercel function and blowing past the 250 MB limit.
  serverExternalPackages: [
    "@duckdb/node-api",
    "@duckdb/node-bindings",
  ],
  // The platform-specific DuckDB binding ships as an optional dependency
  // of @duckdb/node-bindings; pnpm installs the matching one for the build
  // environment (linux-x64 on Vercel, darwin-arm64 locally). Tell file
  // tracing to copy whichever one exists into the function bundle.
  // Route keys must match the Next.js route list output (no /route suffix).
  // Include all routes that transitively import @duckdb/node-api or
  // @malloydata/db-duckdb (which wraps @duckdb/node-api).
  outputFileTracingIncludes: {
    "/mcp/[slug]": [
      "./node_modules/@duckdb/node-bindings*/**/*",
    ],
    "/.well-known/workflow/v1/step": [
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
  },
};

export default withWorkflow(nextConfig);
