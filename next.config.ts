// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import type { NextConfig } from "next";

/**
 * Every route whose module graph reaches Malloy needs DuckDB's native bindings
 * traced into its function bundle.
 *
 * This list is load-bearing and it fails hard. `@duckdb/node-api` is a
 * serverExternalPackage, so the require is resolved when the module is
 * EVALUATED — a route missing from here does not degrade, it 500s on first hit
 * with "libduckdb.so: cannot open shared object file". The browser-side symptom
 * is the unhelpful `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`,
 * because the client's fetch() got the HTML error page instead of JSON.
 *
 * The list must stay equal to the routes importing `@/lib/dashboards/engine` or
 * `@/lib/{malloy,mcp-tools,mcp-host,github-refresh}` — that explicit import IS
 * the "needs the native lib" signal (see src/lib/dashboards/index.ts). Adding
 * such an import to a new route without adding the route here is the bug. To
 * re-derive:
 *
 *   for f in $(find src/app -name route.ts); do \
 *     grep -qE 'from "@/lib/(dashboards/engine|malloy|mcp-tools|mcp-host|github-refresh)"' "$f" \
 *       && echo "$f" | sed 's#src/app##; s#/route.ts##'; done | sort
 *
 * Keys carry no "/route" suffix — Next matches the route path itself.
 *
 * SPELL DYNAMIC SEGMENTS AS "*", NOT "[id]". Next matches these keys with
 * picomatch (build/collect-build-traces.js), where "[id]" is a character
 * CLASS — one character from {i,d} — so a key naming a dynamic segment
 * literally never matches its own route. This hid for a long time because
 * picomatch also runs with `contains: true`, so the bracket-free key
 * "/api/datasets" happens to cover every /api/datasets/[id]/… route as a
 * substring; only routes whose ONLY key was bracketed actually broke, which is
 * why /api/dashboards/[datasetId]/[name]/{view,frame} and
 * /api/ltool/share/[slug] were the visible casualties.
 *
 * Verify a change rather than trusting the glob. After `npm run build`, read
 * the per-route trace manifests under .next/server/app — each route.js.nft.json
 * lists what its function bundle will contain — and confirm every route named
 * here has a "libduckdb" entry. Zero means that route will 500 on deploy.
 */
const DUCKDB_NATIVE_ROUTES = [
  "/mcp",
  "/api/ask",
  "/api/favorites",
  "/api/history",
  "/api/run",
  "/api/schema",
  "/api/dashboards/run",
  "/api/dashboards/*/*/frame",
  "/api/dashboards/*/*/view",
  "/api/datasets",
  "/api/datasets/[id]/model/compile",
  "/api/datasets/[id]/model/github",
  "/api/datasets/[id]/model/push",
  "/api/datasets/[id]/model/status",
  "/api/datasets/[id]/webhook/github",
  "/api/ltool/share/*",
];

/**
 * Both the hoisted copy and any nested one.
 *
 * @malloydata/db-duckdb carries its own nested @duckdb install, and which copy
 * a route resolves depends on its import chain — /api/dashboards/run reaches
 * the hoisted one, /api/dashboards/[datasetId]/[name]/view the nested one,
 * from the same `@/lib/dashboards/engine` import. Tracing follows the JS
 * requires and so picks up `duckdb.node` on its own, but `libduckdb.so` is
 * opened by the dynamic linker at runtime, where no tracer can see it —
 * supplying it is the entire job of this glob. Covering only the hoisted path
 * left the nested resolvers with a duckdb.node and no library behind it.
 */
const DUCKDB_NATIVE = [
  "./node_modules/@duckdb/node-bindings*/**/*",
  "./node_modules/**/@duckdb/node-bindings*/**/*",
];

/**
 * esbuild-wasm, for compiling dashboard artifacts at request time
 * (src/lib/dashboards/bundle.ts). Its Node API spawns `node bin/esbuild`, which
 * reads wasm_exec_node.js and esbuild.wasm by path — no import names them, so
 * tracing cannot find them. One architecture-independent package: unlike
 * native esbuild there is no @esbuild/<os>-<arch> binary to get wrong.
 */
const ESBUILD_WASM = ["./node_modules/esbuild-wasm/**"];

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
    // esbuild-wasm compiles dashboard artifacts at request time. Its API
    // locates its launcher and .wasm by path relative to itself, so it cannot
    // be bundled — keep it external (and traced, below).
    "esbuild-wasm",
  ],
  outputFileTracingIncludes: {
    // The migration journal, applied at boot by src/lib/migrate.ts when
    // RUN_MIGRATIONS_ON_BOOT is set. instrumentation.ts runs in every server
    // function, so trace it into all of them. ("/*" matches only one path
    // segment — it would miss /api/health — hence "/**".)
    "/**": [
      "./drizzle/**/*",
    ],
    // See DUCKDB_NATIVE_ROUTES above — the list was hand-maintained and had
    // drifted: ten routes that import the engine were missing, so every
    // dashboard view/frame, /api/schema, /api/ask, /api/favorites,
    // /api/history and /api/ltool/share 500'd on a cold start. It also named
    // /api/datasets/[id]/model, which no longer exists.
    ...Object.fromEntries(DUCKDB_NATIVE_ROUTES.map((route) => [route, DUCKDB_NATIVE])),
    // The MCP App panel is assembled at request time from two files read off
    // disk: the frame runtime and the ext-apps SDK. Nothing imports them, so
    // tracing cannot see them — without this the panel 500s in production
    // while working perfectly in dev, where the filesystem is just there.
    "/mcp": [
      ...DUCKDB_NATIVE,
      "./public/dashboard-vendor.js",
      "./node_modules/@modelcontextprotocol/ext-apps/dist/src/app-with-deps.js",
      // dashboard_bundle compiles a dashboard at request time — the same
      // reason the /bundle route traces esbuild-wasm.
      ...ESBUILD_WASM,
    ],
    // The dashboard bundle route compiles the artifact at request time. React
    // and the renderer are NOT bundled at runtime (they come from the prebuilt
    // public/dashboard-vendor.js), so they don't need tracing here.
    // Wildcards, not "[datasetId]/[name]" — see the note on DUCKDB_NATIVE_ROUTES.
    "/api/dashboards/*/*/bundle": ESBUILD_WASM,
  },
};

export default nextConfig;
