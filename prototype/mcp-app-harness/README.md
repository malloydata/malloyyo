# MCP Apps harness (prototype)

Exercises `src/lib/mcp-app.ts` without deploying anything or connecting a
client. It stands in for the parts of an MCP Apps host that can actually break:

- the app runs in a sandboxed iframe **without** `allow-same-origin`, so it gets
  an opaque origin, the same as a real host gives it;
- the handshake is JSON-RPC over `postMessage` — `ui/initialize` in, then
  `ui/notifications/tool-result` out, and `ui/notifications/size-changed` back;
- the dashboard is served from a different origin than the app, CORS open, the
  way GitHub Pages serves the real one.

```bash
npm i playwright                      # once, in this directory
WORDFINDER_DOCS=../../../wordfinder/docs \
  DASHBOARD_APP_SITE=http://127.0.0.1:4180 npx tsx gen.ts .   # app.html + tool-result.json
node host.mjs                                                 # :4180 site, :4181 host
CHROMIUM_PATH=$(node -e "console.log(require('playwright').chromium.executablePath())") \
  node shot.mjs out.png
```

`cdn.mjs` is only needed where `cdn.jsdelivr.net` is unreachable (an agent
sandbox): it serves a local `@duckdb/duckdb-wasm` in its place, and `shot.mjs`
points the browser at it with `--host-resolver-rules`. DuckDB also fetches its
`json` and `icu` extensions from `extensions.duckdb.org` at startup, which has
no local stand-in here — without that host the dashboard renders and takes its
inputs but cannot run the query.
