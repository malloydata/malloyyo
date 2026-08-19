// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit .next/standalone (minimal server + traced node_modules) for the Docker image.
  output: "standalone",
  async headers() {
    // Baseline security response headers. There were none at all before this —
    // Vercel supplied none either, so this is not a regression being fixed but
    // a floor being set, and it matters more once the app runs as a plain
    // container with no platform edge in front of it.
    //
    // Deliberately NOT a Content-Security-Policy for the app's own pages. That
    // needs a per-request nonce threaded through the proxy and has to be
    // verified against a real signed-in session before it can ship; a wrong CSP
    // is a blank page. The one route that inlines request-derived data into a
    // <script> — the dashboard frame — sends its own strict CSP at the
    // response level, where it can be checked in isolation.
    return [
      {
        source: "/:path*",
        headers: [
          // Stop content-type sniffing turning a JSON/text response into an
          // executable one.
          { key: "X-Content-Type-Options", value: "nosniff" },
          // The app is authenticated and, until now, framable by anyone —
          // which is the clickjacking precondition. Same-origin framing is
          // required: the dashboard iframe embeds a route from this origin.
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          // Don't leak dataset ids or share slugs in the Referer on outbound
          // links (dashboards can link out via `# link`).
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Fly/Railway/nginx terminate TLS and generally do NOT add this.
          // Ignored by browsers over plain http, so localhost is unaffected.
          //
          // No `includeSubDomains`: a self-hoster on foo.example.com would
          // silently force https on every sibling subdomain they own, which is
          // not this app's call to make and is painful to undo. No `preload`
          // for the same reason, more so.
          { key: "Strict-Transport-Security", value: "max-age=31536000" },
        ],
      },
    ];
  },
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
    // The migration journal, applied at boot by src/lib/migrate.ts when
    // RUN_MIGRATIONS_ON_BOOT is set. instrumentation.ts runs in every server
    // function, so trace it into all of them. ("/*" matches only one path
    // segment — it would miss /api/health — hence "/**".)
    "/**": [
      "./drizzle/**/*",
    ],
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
