# Malloyyo TODO

Running backlog. Newest asks at top of each section; file pointers where known.
When you pick one up, move it to "In progress" or delete the line in the PR that
closes it.

## Dashboards

- [ ] **New multi-tile dashboard layout.** Design a layout for dashboards that
      show several tiles at once — beyond today's grid (`# dashboard` bounded-box
      cards, 361px cap; `packages/cli/src/frame-runtime/`). Wants sizing/placement
      that reads well when a dashboard is many panels rather than one or two.
- [ ] **Drill into measures.** Clicking an aggregate should drill to the rows
      behind it, not just the dimensional `# drill { to= }` navigation we have
      today (`packages/cli/src/frame-runtime/runtime.tsx`, `onCellClick`).
- [ ] **Maybe: better table visualization.** Make table results sortable
      (click a column header to re-sort), and consider an alternative table
      renderer. Today's tables are capped by `tableConfig.rowLimit` (PR #73) with
      no sort — see `packages/cli/src/frame-runtime/runtime.tsx` and
      `src/components/MalloyResultView.tsx`.
- [ ] **Dashboard runs → history.** Record dashboard runs in query history like
      regular queries (so they show up alongside `run_query`/LTool history).
- [ ] **Show all dashboards for a dataset while viewing one.** On the single
      dashboard page (`src/app/datasets/[id]/dashboard/[name]/page.tsx`), list
      the dataset's other dashboards so you can jump between them.
- [ ] **Looker-style filter controls.** Richer filter controls on dashboard
      givens — `contains string`, and the rest of the Looker filter vocabulary
      (starts with, is/is not, in range, is null, etc.). Builds on the existing
      `# tags` control set (`label`, `control=select`, `range_min/max`, `suggest`).
- [ ] **Build Malloyyo-internal analytics dashboards.** Use the v2 dashboard
      system on the `malloyyo_analytics` dataset (instance usage / `tool_calls` /
      query-history analytics).
- [ ] **Whitelisted charting libs for dashboards.** Decide on an allowed set of
      charting libraries for custom dashboard components (deliberately deferred in v2).
- [ ] **`lint` doesn't resolve component imports.** It transpiles a custom
      `dashboards/<name>.jsx` (esbuild transform) but never bundles it, so an
      unresolvable import passes lint and `publish`, then fails at view time with
      `No matching export … for import "X"`. Reproduced with `import { Panel }`
      (not in the `@malloyyo/dashboard` export surface): `lint` ✓, `dashboard
      dev` bundle ✗. Bundle in lint, or resolve the import list against the
      runtime's exports (`packages/cli/src/lint.ts`, `frame-runtime/index.ts`).
- [ ] **Decide whether `Panel` is available to custom components.**
      `frame-runtime/index.ts` deliberately does NOT export it ("you want custom,
      render it yourself") and the reference repo `~/dev/malloyyo-babynames`
      follows that — all three components draw their own visuals and hand-roll
      drill via `postMessage`. But `runtime.tsx:835` still passes `Panel={Panel}`
      as a prop, so `<Panel/>` works if taken from props. Either drop the prop or
      export it; the docs now describe the render-yourself rule.
- [ ] **Filename-coupling is fragile.** A dashboard's `.malloy`, `.jsx`, and
      `# drill { to= }` target are all linked by filename. `lint` now checks the
      links, but consider a less fragile linkage.

## Performance / caching

- [ ] **Suggest caching.** Server-side typeahead / `suggest` is still slow on
      Vercel — cache suggestion results so it's fast.
- [ ] **Model cache: fix or remove.** The durable ModelDef cache
      (`MODEL_DEF_CACHE`, `src/lib/malloy.ts`) is currently **turned off in
      malloyyo prod** (env var removed 2026-07-16) because it keyed by `model.id`
      alone and collided across entry files — dashboards rehydrated index.malloy's
      ModelDef ("undefined object <query>"). Decide: either re-key by
      `(model.id, entryPath)` and turn it back on, or remove the mechanism
      entirely. Turning it off re-introduces the cold-compile latency it was
      meant to fix (see `docs/cold-start-model-cache.md`, baby_names cold start).

## Dataset page / UI

- [ ] **Revisit the dataset page.** `src/app/datasets/[id]/page.tsx` is rough —
      needs a redesign pass.
- [ ] **Move "Refresh from GitHub" to the top of the dataset page.** Currently
      mid-page (~the "Refresh from GitHub" button + `RefreshModal`). Fold into the
      dataset-page redesign above.

## Docs

- [ ] **Trim `README.md` down to a pointer.** The user-facing set now lives in
      `docs/guide/` (PR #111), so the README's architecture diagram, authoring
      walkthrough, deploy checklist, and local-dev section are duplicated — and
      duplicated docs drift. Cut it to the pitch, the diagram, and links into the
      guide. (This supersedes the old "add dashboards to the README" item: the
      dashboards story is now `docs/guide/dashboards.md`.)
- [ ] **`docs/explore-surface.md` lists `open_share_link` as an explore-surface
      tool.** It's host-added in `src/lib/mcp-host.ts`, not part of
      `exploreSurface` — the engine doesn't ship it. Minor, but the doc is the
      design home for that surface.
- [ ] **The `malloyyo-babynames` reference repo README is stale.** It lists
      `Panel` among the importable widgets (it isn't — see the dashboards items
      above), calls the components `Dashboard.tsx` (they're flat
      `<name>.jsx` siblings now), and uses slugs that don't match the filenames
      (`name-explorer` vs `name_explorer`). Separate repo; needs its own pass.

## Known issues / cleanup

- [ ] **Decide whether `export {}` should be an access boundary.** Today it
      curates *discovery* only: `exportedOnly: true` is applied on the
      `list_sources` catalog path (`src/lib/mcp-host.ts:148`), but
      `describe_source` / `query` with an explicit `model_ref` still reach a
      NON-exported source — `explore.ts:195` says so outright and calls it the
      back door. Verified empirically. The `develop/getting-started` help topic
      told authors the opposite ("exactly what consumers can query, nothing
      more"), so a model author may be relying on it to hide a staging source.
      Either enforce it on the describe/query paths or keep it as curation —
      but it should be a decision, not an artifact. (Docs corrected in PR #111.)
- [ ] **No way to create a dataset except from a GitHub repo.**
      `POST /api/datasets` requires `githubRepo` and compiles `index.malloy`
      from the repo as version 1, so even a push-first (`malloyyo publish`)
      workflow has to push to GitHub once to bootstrap. Consider an empty-dataset
      create path (CLI or UI) so the CLI loop stands on its own.
- [ ] **Thorough code review.** No focused review pass has been done across the
      codebase since the v2 dashboard rework landed. Sweep for correctness bugs
      and dead/duplicated code (`/code-review high` or an ultra review).
- [ ] **Dual-install tsc error at `src/lib/mcp-host.ts:118`.** Pre-existing:
      npm root vs pnpm engine copy of `@malloydata/malloy` (two copies of the type).
- [ ] **Remove dead v1 `artifactQueries` composite scans** (superseded by the v2
      file-based dashboard discovery).
