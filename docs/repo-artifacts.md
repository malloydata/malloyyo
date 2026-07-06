# Design: Repo-authored, compiled, sandboxed dashboard artifacts

**Status:** Draft for review — not started. Written 2026-07-04.
**Author:** Lloyd, with Claude.
**Related:** `docs/model-publishing-design.md` (the CLI push-publish path this
reuses), `docs/cold-start-model-cache.md` (the compiled-`ModelDef` cache we key
against), `src/components/MalloyResultView.tsx` (today's trusted renderer).

---

## 1. What we're adding

Today a shareable result is a **Malloy query** — a governed semantic definition
that re-runs live and renders through a trusted renderer (`MalloyResultView` →
`@malloydata/render`). We want something richer: **artifacts** — custom
dashboards (React) that compose multiple queries into a laid-out, interactive
view.

The decision that makes this safe and maintainable: **artifacts are authored in
the model's git repo, alongside the `.malloy` files** — not published live at
runtime through MCP. That single choice buys us the whole discipline models
already have:

- **Git review + provenance** — an artifact is reviewed, committed, versioned
  code, not an anonymous runtime black box. Claude authors it on the command
  line (Claude Code) as a PR that gets checked and merged, exactly like any
  contributor.
- **Compile-time checking** — the artifact declares which model queries/fields
  it uses; we resolve those against the compiled `ModelDef` at publish. Rename a
  field → the artifact fails to compile in CI, loud, like a broken query.
- **A test harness** — run the artifact's declared queries against the model +
  committed fixtures; gate the PR.

Runtime containment (sandboxed iframe + `postMessage` bridge) stays as
**defense-in-depth**, because Malloyyo loads *arbitrary* repos (the Guild /
external instances point at repos we don't own) and this is still code running
in a viewer's browser. Source control raises trust and gives us compile/test; it
is not a substitute for browser-side isolation.

> Rejected alternative: a runtime `publish_artifact` MCP tool that writes
> LLM-authored code straight into a store. It works, but the code is untrusted
> forever with no review, no compile check, and no test — the sandbox is the
> *only* thing standing between it and a viewer. Moving authoring into the repo
> keeps the sandbox **and** adds review + compile + test. Strictly better.

## 2. The core constraint: declare data, free-form presentation

For an artifact to be compile-checkable and testable, its **data dependencies
must be statically extractable**. So the contract is:

- **Data layer = named, parameterized views.** The best form (see below) is: the
  artifact binds to **views defined on the model's sources**, supplying **typed
  parameters — the *givens* — for filters**. It does *not* embed arbitrary Malloy;
  the callable surface is the set of views the model author chose to expose. It
  never builds query strings at runtime and never fetches on its own.
- **Presentation layer = arbitrary React.** Given the view results (handed in),
  the artifact can lay out and render however it likes.

This is the same governance conclusion we'd want anyway ("numbers only ever come
through Malloy") — but now it's **enforced by the build**, not hoped for. An
artifact declaring `top_customers` + `revenue_by_month` has those resolved
against the `ModelDef` at publish and exercised by the test harness.

### The best architecture: views + givens (not Malloy source parameters)

Rather than each artifact inventing its own Malloy, the **model's sources expose
named views**, and artifacts pick a view and pass filter inputs — **givens**:

```malloy
// in the .malloy model — the governed surface, authored & reviewed once
source: orders is duckdb.table('orders.parquet') extend {
  view: revenue_by_month is { group_by: ordered_at.month; aggregate: revenue }
  view: top_customers    is { group_by: customer; aggregate: revenue; limit: 10 }
}
```

The artifact is *declared in the model* — a `# artifact`-tagged top-level query
(**updated 2026-07-06: there is no manifest file; the tag is the manifest**):

```malloy
#" Names most concentrated in the selected state vs. the nation
# artifact name="over-represented" title="Over-represented baby names"
query: over_represented_names is baby_names -> overrepresented_by_gender
```

```
dashboards/
  over-represented/
    Dashboard.tsx   # OPTIONAL custom component (imports @malloyyo/dashboard);
                    # without one the runtime auto-renders title + controls
                    # (from the query's given specs) + the result panel
```

**Parameterization uses givens — deliberately NOT Malloy's source parameters
(`param::type`).** Givens are the forward mechanism that will *replace* source
parameters, so the artifact layer targets them from the start rather than binding
to something being retired.

> **Givens & filters — current state (updated 2026-07-06, shipped):**
> *filter-expression* givens are the standard now. A model declares
> \`given: STATE :: filter<string> is f'CA'\` and applies it with \`~\`
> (\`where: state ~ $STATE\`); the dashboard binds filter-expression *strings*
> ('CA', 'CA, NY', 'Ann%', '[1910 to 1930]', '> 200'), so one given covers
> single-value, multi-value, wildcard, and range controls without model
> changes. Raw scalar givens still work but new models should prefer
> \`filter<T>\`. The prototype (\`examples/babynames\`, and the full
> malloyyo-babynames repo) does this end to end.
>
> **The model is the single source of truth for the whole contract.** The
> dashboard itself is a `# artifact` tag on a query (manifest.json is gone —
> stored manifests are synthesized from the tag at publish/refresh); the
> runtime introspects the query's transitive `given:` declarations — type,
> literal default, `#"` doc comment, and `# key=value` tags (`label`,
> `control`, `suggest {…}`, `range_min/max`, …) — and hands them to the
> artifact as `givenSpecs`. A structured `# suggest { source=names
> dimension=state }` (or `# suggest { query=state_options dimension=state }`)
> tag populates a control's options as a restricted query — distinct values of
> a source dimension, or a named query's first column — and, when a
> `dimension` is declared, gets server-side typeahead: the runtime refines it
> with `+ { where: lower(field) ~ f'<typed>%'; limit: 50 }`. The frame runtime
> (`packages/cli/src/frame-runtime/`, ONE implementation bundled by both the
> CLI dev server and the hosted vendor asset) provides `@malloyyo/dashboard`:
> headless widgets (`Controls`/`Given`/`Select`/`Search`/`Range`, themed via
> `--dash-*` CSS vars), hooks (`useGiven`/`useOptions`/`useQuery`), and
> `filters` helpers (built on `@malloydata/malloy-filter`) so artifacts never
> hand-concatenate a filter expression.

Why this beats declared-but-arbitrary Malloy:

- **Governed surface, defined once.** What an artifact *can* query = the views the
  model author exposed. Consistent numbers across every dashboard; the model — not
  the artifact — owns the semantics.
- **Interactivity = givens, not query rewriting.** Drill-down, date ranges, region
  filters are *typed parameters* on a fixed view, so an artifact is fully
  interactive without ever widening what it can reach.
- **Trivial, total compile-check.** Resolving `source.view` + given names (types
  where givens declare them) against the `ModelDef` is a lookup — no parsing
  arbitrary Malloy out of an artifact.
- **Smaller runtime surface.** The postMessage bridge carries typed `{ view,
  givens }`, not a Malloy string.

**Arbitrary Malloy is allowed — as *restricted* queries (decided 2026-07-06).**
Restricted mode is exactly the contract built for untrusted query text (it's
what the explore MCP surface runs under): no \`import\`, no \`given:\`
declarations, no \`connection.table/sql\`, no raw SQL, no \`##!\` flags — only
the model's published surface. Dashboards use it for \`# suggest {…}\` option
population, \`<Panel malloy="…"/>\` ad-hoc panels, and \`runData()\`. Named
queries remain the primary form for anything substantial (reviewed, reusable,
consistent numbers); restricted text is the sanctioned small-stuff channel, and
lint compile-checks every \`suggest\` declaration against the model.

`Dashboard.tsx` imports only from a **whitelisted surface** (React + one charting
lib) — no arbitrary `npm` reach, so bundles stay bounded and reviewable.

## 3. Where the code is today (what we reuse)

The push-publish + versioned-storage + compiled-cache machinery already exists;
artifacts extend it rather than inventing a parallel path.

| Concern | Location |
|---|---|
| CLI push-publish (git provenance, transactional) | `docs/model-publishing-design.md`; `malloyModels.gitRepo/gitBranch/gitSha/gitDirty`, `lastPublish*` (`src/db/schema.ts:139`) |
| Per-file storage for a model version | `malloyModelFiles` (path + content) (`schema.ts:177`) |
| Immutable versioning | `malloyModels.id` — a repo edit is a new row/version |
| Compiled `ModelDef` (for resolve/check) | `compiledModelDef` bytea + `src/lib/model-cache.ts` (`packModelDef`/`readModelDef`, `rehydrateModel` → `_loadModelFromModelDef`) |
| Governed, viewer-scoped query execution | `/api/run` → `runQueryForWeb` → `runMalloyFiles`; enforces `visibleDatasetWhere` (`src/lib/mcp-tools.ts`, `src/lib/malloy.ts`) |
| Shareable slugs | `instanceSlug()` `<code>_<nanoid>` (`src/lib/slug.ts`); `savedQueries`/`history` |
| Trusted result renderer | `MalloyResultView` (`src/components/`) |
| Page auth gate | `src/proxy.ts` (sign-in required for any page but `/`) |

## 4. Storage & loading

**A new table `malloyArtifacts`**, keyed to a model version (same shape idea as
`malloyModelFiles`):

```
malloy_artifacts
  id            uuid pk
  model_id      uuid → malloy_models.id  (cascade)   -- pins to a model VERSION
  slug          text  -- artifact identifier within the model, e.g. "sales-overview"
  manifest      jsonb -- { title, queries, deps }
  source        text  -- the Dashboard.tsx source (reviewable in the DB too)
  compiled      bytea -- gzip(bundled JS) — built once at publish, like compiledModelDef
  compile_error text
  created_at    timestamptz
```

- **Published by the same CLI transaction** that publishes the model
  (`model-publishing-design.md` §4.4): the CLI pushes model files *and* the
  `artifacts/` dir; the server compiles both or fails the whole publish. An
  artifact is thus always paired with a model version it was checked against — no
  drift between them by construction.
- **Compiled bundle cached as gzip `bytea`**, exactly the pattern
  `compiledModelDef` uses — build (esbuild transpile of the TSX against the
  whitelisted import surface) once at publish, rehydrate cheaply at serve time.
  Null `compiled` + non-null `compile_error` = publish recorded the failure but
  it never becomes servable (mirrors the model publish-failure handling).
- **Pull path** (`refreshGitHubModel`, `src/lib/github-refresh.ts`) extends the
  same way for github-pull datasets: read `artifacts/` alongside the model.

## 5. Compile & check (at publish)

For each artifact, at publish (server side, same place model `sources`/
`compiledAt` get written):

1. **Resolve the ModelDef** for the model version being published
   (`rehydrateModel` from `model-cache.ts`, or the fresh compile).
2. **Static-check the manifest's views + givens** against it: each referenced
   `source.view` exists and each supplied given is one the view accepts (types
   checked where givens declare them). (An escape-hatch inline query is compiled
   instead.) A missing/renamed view or an unaccepted given fails here — loudly, in
   CI, before merge.
3. **Bundle `Dashboard.tsx`** with esbuild against the whitelisted imports;
   reject any import outside the allowlist. Store the gzip bundle in `compiled`.
4. **Transactional:** if any artifact fails (1)–(3), the publish fails as a unit
   — you never get a model version whose artifacts don't compile against it.

This is what kills "model drift" dead: an artifact and the model it renders are
compiled together or not at all.

## 6. Test harness

A `malloyyo artifact test` step (local + CI):

- **Data smoke test (cheap, primary):** run every declared query against the
  model on DuckDB with a **committed fixture dataset** (small sample tables, so
  CI needs no live-warehouse credentials) — assert each compiles and returns the
  expected column shape. Catches the majority of breakage.
- **Render snapshot (optional):** headless-render `Dashboard.tsx` (jsdom /
  Playwright) with the fixture results and snapshot the output. Guards
  presentation regressions.
- **CI gates the PR** — a broken artifact can't merge, same bar as the models.

Fixtures live in the repo next to the artifact (e.g. `artifacts/*/fixtures/`) so
the test is hermetic and reviewable.

## 7. Local authoring & preview: `malloyyo artifact dev`

The authoring loop can't require a publish to see a dashboard render. The CLI
runs a **localhost dev server** that previews an artifact using the *same*
runtime harness the deployed app uses — so "works in dev" means "works in prod."
This is the interactive counterpart to §6's test harness.

- **Same shell, shared code.** The sandboxed-iframe + `postMessage` shell (§8) is
  a shared module imported by both the dev server and the deployed page. The
  *only* thing that differs is the query backend behind the bridge — swapping
  that out must be the single seam, or fidelity is lost.
- **In-process query backend.** Locally the bridge's "run declared query" handler
  runs Malloy **in-process on DuckDB** against the repo's model (the CLI already
  has the `.malloy` files) instead of calling `/api/run`. It enforces the **same
  declared-view-only gate** — the iframe still can't run arbitrary Malloy — so
  fidelity holds; only auth/viewer-scope (irrelevant to a single local dev) is
  dropped.
- **Data source: fixtures or live.** `--fixtures` runs declared queries against
  the committed sample tables (hermetic, offline, fast — the same data §6's tests
  use); default/`--live` hits the model's real sources with the dev's own
  warehouse creds. Author against fixtures, sanity-check against live.
- **Watch + hot reload.** Watches `artifacts/` and the `.malloy` files; on edit,
  re-bundles with esbuild, re-runs the §5 compile-check (resolve declared queries
  against a fresh `ModelDef`, enforce the import allowlist), and pushes a reload.
  Compile/drift errors surface *while editing*, identical to CI/publish.
- **Two-port origin fidelity.** Serve the shell on one port and the iframe content
  on another (`localhost:4000` shell, `:4001` artifact) — different ports are
  different origins, so the **separate-origin sandbox story (§9 open question #1)
  becomes testable locally**, de-risking that decision before we commit to it in
  prod.
- **Shared substrate with `test`.** The in-process Malloy runner + fixture loader
  are the same ones `malloyyo artifact test` (§6) uses; `dev` is the interactive
  face, `test` the CI face — one code path, two entrypoints.
- **Claude-Code-friendly.** Because it's a plain localhost server, the CLI author
  (Claude Code) can drive/screenshot it to self-verify an artifact it just wrote
  — closing the author→verify loop on the command line, the same way the `/run`
  and `/verify` skills drive an app.

## 8. Runtime: sandboxed iframe + `postMessage` bridge (unchanged security model)

Serving an artifact is where the *runtime* boundary lives. Two layers:

- **Trusted shell** (your page, on the app origin). Knows the signed-in viewer,
  can call `/api/run`. Loads the compiled bundle and mounts it in an iframe.
- **Untrusted artifact** in an `<iframe sandbox>` **without `allow-same-origin`**,
  ideally served from a **separate origin** (see §8). It has no session, no
  token, no network. Its only channel is `postMessage`.

Flow:

```
artifact  --postMessage-->  shell : { query: "over_represented", givens: { STATE: "CA, NY" } }
                                    or { malloy: "run: names -> state" }   // restricted text
shell     : calls /api/dashboards/run WITH the viewer's session
            → named query = the model's published surface; malloy text =
              core's RESTRICTED mode (no import/given:/connection.*/raw SQL)
            → governed, visibleDatasetWhere-scoped
shell     --postMessage-->  artifact : { stableResult, rows }
artifact  : renders
```

The server is the single enforcement point: a named query must be one the model
publishes, query text runs under restricted mode (the compiler rejects anything
that reaches outside the published surface), every run is scoped to the current
viewer (`visibleDatasetWhere`), and the bridge can rate-limit/log. The artifact
can at worst draw a wrong chart *inside its booth* — it never holds credentials,
never runs its own SQL, never reaches other data.

**Artifacts get slugs too** — `/artifact/<slug>` served through the same
sign-in-gated page path as `/ltool/<slug>`, resolving `malloyArtifacts` by slug.

## 9. Open questions / decisions to make

1. **Separate origin vs. same-origin sandbox.** `sandbox` without
   `allow-same-origin` is the floor. A *separate origin* for the iframe content
   is stronger defense-in-depth. Note the `*.vercel.app` cookie caveat (Public
   Suffix List — can't share a session cookie across two `*.vercel.app`
   subdomains); a real separate-origin story wants custom domains under a shared
   parent (`app.` / `artifacts.<domain>`). Decide v1 = same-origin sandbox, later
   = separate origin? **Update (2026-07-05):** v1 briefly shipped with
   `allow-same-origin`, which *defeated* the sandbox — now fixed
   (`sandbox="allow-scripts"`, token-gated assets). Separate origin remains the
   defense-in-depth step. See `dashboard-iframe-security.md`.
2. **Query declaration form — DECIDED, revised 2026-07-06 (§2).** Named
   **queries + givens** exposed by the model are the primary form; **inline
   Malloy is allowed as restricted-mode text** (suggestions, ad-hoc panels) —
   core's restricted compiler is the gate, not manifest declaration.
   Parameterization is **givens, not Malloy source parameters** (givens will
   replace them), and givens should be **filter-expression typed**
   (`filter<T>`, applied with `~`) — shipped; multi-value/range/wildcard
   controls all bind to one given. The model's `given:` declarations (+
   `# label`/`suggest {…}` tags) are the single source of the control
   contract; manifests no longer redeclare givens.
3. **Whitelisted import surface.** Pin React + which charting lib? (Recharts?
   `@malloydata/render` primitives?) The allowlist bounds bundle size and review
   surface.
4. **Interactivity depth — answered by §2, shipped.** Interactivity = passing
   *filter-expression given values* to a query (the prototype's STATE select is
   populated by a `# suggest {…}` restricted run; its year range is one
   `filter<number>` given driven by a dual slider via `filters.between`).
   Multi-value/range/wildcard controls all ride the same mechanism.
5. **Fixture strategy for tests.** Committed sample tables vs. a recorded result
   snapshot per query. Sample tables exercise the real Malloy compile; snapshots
   are lighter but can rot.
6. **Does MCP still reference artifacts?** Authoring moves to the repo, but a
   read-only MCP tool (`list_artifacts` / an artifact link in a query result)
   could still point Claude/end-users at published dashboards. Nice-to-have, not
   v1.

## 10. Why this is the right shape

- **Correctness & provenance** come from the repo pipeline (review, compile,
  test, immutable versioning) — build time.
- **Containment** comes from the sandbox + `postMessage` + viewer-scoped governed
  queries — run time.
- **Governance** ("numbers only through Malloy") is enforced by the
  declare-queries constraint, checked by the compiler.

The layers compose; none is load-bearing alone. An artifact is a first-class repo
citizen that compiles and tests like a model, and a compromised or hallucinated
one can't touch data or credentials.
