# Explorer dashboards — a query builder as a kind of dashboard

**Status:** Prototype, 2026-10-07. Built to replace Malloy Explorer (the
point-and-click query builder) with something that lives inside Malloyyo, and
then retire Explorer. Design record: `knowledge/malloyyo/explorer-plan.md`
(mtoy's brain); this file is the as-built.

## What it is

An **explorer** is a dashboard with no query of its own. The file declares a
source, and the runtime draws a builder over it:

```malloy
// dashboards/explore.malloy
##! experimental.givens
import "../index.malloy"

## artifact { explore="orders" title="Explore orders" }
```

```
 givens + field tree  |  builder (group by / aggregate / filter / nest / …)  |  result
                      |  Run · Clear · the generated Malloy, read-only       |
```

Click a dimension to group by it (dates get a truncation selector), a measure
to show it, a numeric dimension's Σ to aggregate it inline (`amount.sum()`),
`filter` to add a filter box, a view to start from it (`source -> view + {…}`)
or nest it; `+ nest` opens a nested stage with the same builder. Pick a viz tag
per stage. Run. Every run is restricted Malloy text through the same host
bridge every dashboard uses, so governance is unchanged.

## The three decisions

1. **The builder is the state; the Malloy text is its output.** The emitter
   (`packages/cli/src/frame-runtime/explore-emit.ts`) is small and dumb: it
   knows how to spell statements and nothing about legality. **The compiler is
   ground truth** — a bad query is the compiler's error, shown on the result
   panel. There is no second model of the language (that was Explorer's
   `malloy-query-builder` coupling, and the thing being retired). The text is
   shown read-only so users learn Malloy by watching; text → builder is not a
   goal.
2. **It is runtime code, mounted in the trusted page** (`ExplorerDashboard`
   in `frame-runtime/explore-ui.tsx`, picked by `mountInPage`/`mountStatic`/
   `mountDashboard` when `dashboardInfo().explore` is set) — not a sandboxed
   custom component. A custom component cannot use the Malloy renderer by
   design; an explorer's results are the renderer. It therefore runs on all
   three hosts (web in-page, MCP Apps panel, static/WASM) for free.
3. **Filters are text boxes, not operator pickers.** The text is a filter
   expression (`last week`, `CA, NY`, `> 100`, `$GIVEN`). Tier 1: it parses →
   it is the filter. Tier 2: it doesn't (or it's a string field, where any text
   parses as an equality) → "✨ write it" asks the host's model, which has the
   filter-language reference (`yo_help language/filter-expressions`), the
   field's type and some of its values; the answer is parser-validated and
   lands in the same box, editable, with a one-line note. The user always sees
   the exact filter that will run. Emitted as `~ f'…'` only — never partials.

## What the host injects

`dashboardInfo().explore = { source, description, write_filter }`:

- `description` — the engine's `describeSource` + `projectDescription(…, "explore")`:
  the public members of the source and its join closure, name-keyed, with
  `relationship` on joins (the frame marks `fans out`).
- `write_filter` — whether this host can turn a description into a filter.
- `givenSpecs` — EVERY given declared in the dashboard file's scope
  (`declaredGivenSpecs`), not the referenced set (there is no query yet). They
  render as controls above the field tree and ride with each Run; a filter box
  containing `$NAME` applies the given itself.

Hosts: the dev server (`packages/cli/src/dashboard.ts` `resolveGivens`, route
`/api/write-filter` when `ANTHROPIC_API_KEY` is set), the hosted app
(`src/lib/dashboards/engine.ts` `exploreViewData`, route
`/api/dashboards/write-filter` when Ask is enabled). The MCP Apps panel gets the
same `info` through `dashboard_bundle`; `writeFilter` is absent there today.

## Engine changes

- `ArtifactInfo.explore?: string`; `readArtifactTag` reads `explore=`;
  `modelArtifact` / `artifactQueries` accept it.
- `declaredGivenSpecs(runtime, entry)` beside `dashboardGivenSpecs`.
- `writeFilterPrompt` / `parseWriteFilterAnswer` (pure; the host calls the model).
- Help topic `language/filter-expressions` — the filter sub-languages, every
  example verified against `@malloydata/malloy-filter`'s parsers.

## Not in the prototype (and why)

- **Implicit explorer for every source** (no file). The Explorer use case; a
  follow-up that synthesizes `info.explore` for `/datasets/<id>/explore/<src>`.
- **Per-source customization by the LLM.** Expressed as tags on the model via
  the drafts loop, not generated React. Not started.
- **calculate / windows, pipeline stages, pivot, drill from cells, source
  parameters, drag reorder.** Explorer's calculate was one hard-wired moving
  average; stages and pivot it never had. Drill: see the open question.
- **Text → builder.** Would need "compile this query and give me its shape"
  on the explore surface. Not required for the builder; required for the
  open question below.

## Open question: drill as "open an explorer here"

mtoy's idea (2026-10-07): click a number in any dashboard and open an explorer
already filled out to the part of the query that number came from — replacing
`drill:`. This is the text → builder direction: the compiler hands the frame the
query's shape at that cell (stage, group-by values, filters, the nest path) and
the builder is seeded from it. The mini-spec marks `drill:` itself `[open]`
(§6.6: a language feature or a renderer protocol?); this would answer it from
the UI side.

## Verifying

```
cd examples/explorer-demo
npx tsx ../../packages/cli/src/index.ts dashboard dev     # http://localhost:4173/?d=explore
npx tsx ../../packages/cli/src/index.ts lint
cd ../../packages/cli && npx tsx --test test/explore-emit.test.ts test/write-filter.test.ts
```
