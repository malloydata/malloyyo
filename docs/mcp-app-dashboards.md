# Pre-built dashboards in an MCP App panel

**Status:** Stage 0 is built and passing. The rest is design. The prototype that exists today
(`src/lib/mcp-app.ts`) renders a hand-written table, not a real dashboard.

The goal: a dashboard the user already authored — a React dashboard under
`dashboards/*.jsx` — rendered inline in Claude as an MCP App, driven by the same
frame runtime that drives it in the web app.

## What exists today

The web app already renders these dashboards in a sandboxed iframe, and the
shape is closer to an MCP App than it looks.

```
/api/dashboards/[datasetId]/[name]/frame   the iframe document
  <div id="root">
  window.__DASHBOARD__ / __DASHBOARDS__ / __GIVENS__    inlined, nonce'd
  FRAME_BOOTSTRAP           reads givens + ~state from location.search
  /dashboard-vendor.js      the frame runtime (4.4 MB)
  .../bundle?t=<token>      the dashboard, esbuild'd from source per request
```

The runtime (`packages/cli/src/frame-runtime/runtime.tsx`) talks to its parent
over `postMessage`:

```js
parent.postMessage({ type: "run", id, query, malloy, givens }, "*")
parent.postMessage({ type: "navigate", dashboard, givens }, "*")
parent.postMessage({ type: "givens", givens }, "*")
parent.postMessage({ type: "urlstate", state }, "*")
```

The parent forwards `run` to `POST /api/dashboards/run` →
`runDashboard(userId, datasetId, name, { query, malloy }, givens)`, which
dispatches:

- **`malloy`** → `runRestricted(runtime, entry, text, { givens, stableResult, rowLimit })`
  — core's restricted mode rejects anything outside the model's published
  surface with `restricted-construct-forbidden`.
- **`query`** → `runNamedMalloyFiles(files, entryFile, runExpr, givens)` — a
  single run-expression: a `<Panel query=…>`, one tile of a composite grid, or a
  v1 dashboard's stored query.

Two properties matter for what follows:

1. **The runtime already abstracts its host.** There is a postMessage host and a
   direct-fetch host, selected at runtime. An MCP App is a third host, not a
   second renderer.
2. **v2 compiles against the dashboard's own file**, `manifest.entryFile =
   dashboards/<name>.malloy`, not `index.malloy`, so the dashboard's inline
   query and imports are in scope.

## The query-protocol change

Today the wire carries two fields and the caller decides which to set. The
proposal is one field, with the sniff doing the work:

> A run string beginning with `run:` is **Malloy text**; anything else is a
> **named run-expression**.

That is unambiguous — a named run-expression is `source -> view` or a bare view
name, and cannot begin with `run:`.

```ts
// src/lib/dashboards/engine.ts
const isMalloyText = (s: string) => /^\s*run\s*:/.test(s);
```

Dispatch, and **which model each compiles against**:

| Input | Runner | Entry |
|---|---|---|
| `run: …` | `runRestricted` | `index.malloy` — the model's published surface |
| `orders -> by_month` | `runNamedMalloyFiles` | `manifest.entryFile` |

**Worth deciding explicitly, because it is a change.** Ad-hoc `run:` text
against `index.malloy` is the right call: that is the published surface the
restricted runner is designed to gate, and the same surface the MCP `query` tool
already uses, so a panel gets exactly the reach a model gets — no more. But note
it is *not* what `runDashboard` does today for `malloy` (it uses `entryFile`, so
the dashboard's own imports are in scope). Splitting them means:

- a **tile** keeps `entryFile` — it must see the dashboard's inline query;
- **ad-hoc text** uses `index.malloy` — it must not.

If instead ad-hoc text should also see the dashboard's imports, say so and it
stays on `entryFile`; the restricted gate is what provides safety either way,
not the entry file.

The existing two-field form stays accepted, so nothing that calls it breaks.

## The panel

An MCP App is one self-contained HTML resource, loaded into a sandboxed iframe
by the host, addressed by a `ui://` URI. Three consequences:

**1. Everything inlines.** No `/dashboard-vendor.js`, no `?t=` bundle fetch —
the panel cannot reach our origin without CSP entries we should not want. The
resource must carry the runtime *and* the compiled dashboard. That is ~4.4 MB of
vendor plus the dashboard's own bundle. MotherDuck's dive viewer ships 4.6 MB
through the same channel, so this is heavy but not disqualifying.

**2. The server is reached through the host.** `app.callServerTool` asks the
host to proxy a `tools/call` as the connected user. No CORS, no credentials in
the panel. This is what the third runtime host does:

```js
// frame-runtime: a third host alongside postMessage and direct-fetch
run: async (req, givens) =>
  (await app.callServerTool({
    name: "dashboard_run",
    arguments: { dataset, dashboard, query: req.query ?? req.malloy, givens },
  })).structuredContent
```

`navigate` / `givens` / `urlstate` become app-local state — there is no URL to
own inside a panel, though `urlstate` could later map to the SDK's own state
mechanism so a shared conversation reopens the same view.

**3. Which dashboard is a runtime value, not a URI.** A tool's
`_meta.ui.resourceUri` is fixed, so one tool cannot point at a per-dashboard
resource. The dashboard identity has to arrive in the **tool result**, and the
panel loads that dashboard's bundle itself — via a second, app-only tool
(`visibility: ["app"]`, so the model never sees it).

## Risks, highest first

**1. `unsafe-eval` — ANSWERED, not a blocker.** Stage 0 shipped the real 4.4 MB
`dashboard-vendor.js` plus an esbuild'd dashboard in a `ui://` resource and it
renders in a Claude panel: React mounts, state works, the button counts. It also
renders locally under an explicit `script-src 'unsafe-inline'` with eval
forbidden, so the frame CSP's `'unsafe-eval'` is needed by *some paths*, not by
loading.

Still untested: the two `new Function` sites (CSV / expression paths). A
dashboard that exercises them may still need eval, and no `_meta.ui.csp` field
can request it. Test with a dashboard that hits those paths before promising
parity.

The original concern, kept for the record:

**1a. Why this looked fatal.** The frame's own CSP grants
`script-src 'nonce-…' 'unsafe-eval'`, because the renderer compiles with the
`Function` constructor (2 sites in `dashboard-vendor.js`). An MCP App resource
declares CSP through `_meta.ui.csp`, which exposes only `connectDomains`,
`resourceDomains`, `frameDomains`, `baseUriDomains` — **there is no way to
request `unsafe-eval`**. If the host's sandbox denies it, the renderer breaks on
any path that hits those call sites, and possibly at load.

This is the one that decides whether the whole approach works, and it is cheap
to answer. **Do it first** (see below).

Dynamic bundle loading has the same exposure: injecting the dashboard's compiled
JS from a string needs `eval`, a `blob:` script, or a `data:` URL, all of which
the sandbox may refuse.

**2. Query latency.** Measured on localhost, single-row aggregate:

```
Malloy engine     compile 5 ms + run 334–598 ms
/api/run          2.1–3.2 s
/mcp from panel   5.7 s
```

~90% of the panel's time is above the engine, and `/mcp` adds roughly twice the
overhead `/api/run` does. A dashboard with six tiles issues six of these. Until
that comes down, a panel dashboard will feel materially worse than the same
dashboard in the web app. **This is the real prerequisite**, and it is worth
fixing on its own merits — it affects every MCP query, not just panels.

**3. Payload size.** 4.4 MB of vendor per `resources/read`. Content-addressed
URIs (already in place) mean clients cache it, so the cost is per-client rather
than per-call — but it is paid on a cold panel, and on mobile.

**4. Feature loss.** `# link` navigation, image hosts, and anything depending on
the URL do not exist in a panel. Worth an inventory before promising parity.

## Staged plan

**Stage 0 — DONE.** `prototype/stage0/build.ts` assembles the panel document
and `show_frame_test` serves it. Renders in Claude Desktop.

Two things it taught:

- **The panel is the frame AND an MCP App.** The first attempt was the frame
  document alone; it rendered into a zero-height box because nothing sent
  `ui/initialize` or `size-changed`, which is indistinguishable from a failed
  render. The fix is ~6 lines at the end of the document:

  ```js
  const app = new App({ name: "Malloyyo Frame", version: "0.1.0" });
  app.connect().then(() => app.setupSizeChangedNotifications());
  ```

  Everything above it is the ordinary frame. **Wire the SDK first, always.**

- **Every app change needs a client reconnect.** `_meta.ui.resourceUri` lives in
  `tools/list`, which clients cache hard, so a content-addressed URI means a
  Desktop restart per iteration. A stable URI plus a short `ttlMs` would avoid
  that in development, at the price of body staleness — both failure modes were
  hit during this work, so pick deliberately.

**Stage 0 (original plan, for reference).** Serve a `ui://`
resource containing `dashboard-vendor.js` and a trivial dashboard, with data
inlined so no query is needed. If it renders, the CSP question is answered and
the rest is work. If it dies on `Function`, stop and reconsider — the answer
would be either a renderer build without eval, or server-side rendering to
static HTML with interactivity limited to what the panel can do itself.

Cost: an hour. Answers the only question that can invalidate the design.

**Stage 1 — the protocol.** The `run:` sniff in `runDashboard`, plus the entry
split above. Purely server-side, testable without any panel, and useful to the
existing web frame regardless.

**Stage 2 — the third runtime host.** `frame-runtime` gains a `callServerTool`
host beside the existing two. `Panel`, `useQuery`, `useGiven` unchanged.

**Stage 3 — resource assembly.** `resources/read` returns runtime + bootstrap +
the esbuild'd dashboard, content-addressed so a changed dashboard is a new URI.
`show_dashboard(dataset, dashboard)` names the dashboard in its result; the
app-only `dashboard_run` tool serves queries.

**Stage 4 — parity pass.** Inventory what a panel cannot do and decide, per
item, whether to emulate or drop.

## What this replaces

Nothing. The web dashboard surface stays as it is. This adds a host to the
existing runtime rather than a second renderer — which is the point. Two
dashboard systems would fork the frame runtime, and that is the outcome worth
avoiding.
