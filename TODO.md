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

## Docs

- [ ] **Add dashboards to the README.** `README.md` only mentions dashboards in
      passing (the intro bullet and the `malloyyo test` paragraph). It needs a
      real section: what a repo-authored dashboard is, the `# artifact` +
      `givens` contract, and where the full authoring guide lives
      (`docs/repo-artifacts.md`, `yo_help` topics under `dashboards/*`).

## Known issues / cleanup

- [ ] **Thorough code review.** No focused review pass has been done across the
      codebase since the v2 dashboard rework landed. Sweep for correctness bugs
      and dead/duplicated code (`/code-review high` or an ultra review).
- [ ] **Dual-install tsc error at `src/lib/mcp-host.ts:118`.** Pre-existing:
      npm root vs pnpm engine copy of `@malloydata/malloy` (two copies of the type).
- [ ] **Remove dead v1 `artifactQueries` composite scans** (superseded by the v2
      file-based dashboard discovery).
