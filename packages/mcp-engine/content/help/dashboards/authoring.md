---
description: How to author a dashboard — a self-contained file in the dashboards/ directory that defines its own query; the entry point for dashboard how-to
---

# Authoring dashboards

A dashboard is a **self-contained `.malloy` file in the `dashboards/`
directory**. The file IS the dashboard: it imports the model parts it needs,
defines its query (with the filtering it applies), and tags it. No manifest, and
for the basic case no JavaScript. Preview with `malloyyo dashboard dev`; check
with `malloyyo lint`. Requires `@malloydata/malloy` 0.0.423+.

Related: `yo_help dashboards/givens-and-controls` (filter controls),
`dashboards/grid-layout` (columns/colspan/break), `dashboards/custom-components`
(a flat `<name>.jsx`), `dashboards/vega-charts` (`<VegaChart>`).

> **Need a chart the `# bar_chart`/`# line_chart`/`# shape_map` tags can't do?**
> Use the `<VegaChart>` COMPONENT (a Vega-Lite spec over query rows) — NOT a `#`
> tag; there is no `# vega_lite`. See `yo_help dashboards/vega-charts`.

## The layout

```
model/
  ecommerce.malloy     # sources, reusable views/measures, # drill tags
  givens.malloy        # given: declarations (the filter controls)
  index.malloy         # imports/exports sources — the MCP/data surface ONLY
  dashboards/
    overview.malloy    # one dashboard; the FILENAME is its name/slug
    overview.jsx       # optional custom component for overview
```

**The filename is the dashboard's name** — its URL slug, its `# drill` target,
and the basename of its optional component. Discovery globs
`dashboards/*.malloy` and compiles EACH as its own entry — so dashboards are NOT
declared in, or exported through, `index.malloy` (`index.malloy` is just the
`query`/`describe_source` data surface).

## Preferred: put the query IN the dashboard file

Define the query right in `dashboards/<name>.malloy` and tag it `# artifact`, so
the given mapping (the `where: … ~ $GIVEN`) is visible next to the dashboard:

```malloy
// dashboards/overview.malloy
##! experimental.givens
import "../ecommerce.malloy"          // BARE import: source + givens in scope

#" Business health at a glance — sales, margin, orders.
# artifact { title="Business Overview" } dashboard {columns=6}
query: overview is order_items -> {
  where:                                            // the given mapping, HERE
    inventory_items.product_brand ~ $BRAND,         // multi-filter where: is
    inventory_items.product_category ~ $CATEGORY,   // COMMA separated
    created_at ~ $PERIOD
  # colspan=2
  aggregate: total_sales, total_gross_margin, order_count
  # colspan=3
  nest:
    # line_chart
    sales_trend is by_month
    top_brands
    # shape_map
    sales_by_state
}
```

That's a complete dashboard: the runtime auto-renders a title (the tag's
`title`, else the `#"` doc), a control for every given the query references, and
the result panel. `# artifact` DECLARES the dashboard; `# dashboard {columns=6}`
is the renderer tag that draws it as KPI tiles + a card grid — partners, on the
same line. Grid rules: `yo_help dashboards/grid-layout`.

**You know you're doing it right when the `where: foo ~ $FOO` is in the DASHBOARD
file, not the model.** Keep the model's sources/views reusable and given-free;
each dashboard decides its own filtering.

**The bare import is required for controls.** A control renders only when the
given's DECLARATION is in the dashboard file's scope — a bare
`import "../ecommerce.malloy"` (or `import "../givens.malloy"`) brings them all;
the runtime shows a control for exactly the givens the query references. A
selective `import { order_items } from …` brings the filter but NOT the control.

Keep the FILENAME as the name — don't set `name=`, so the URL, the
`# drill { to=… }`, and the component basename all agree (one source of truth).

## Other forms

- **A view of a source you extend in the file** — tag the dashboard `view:` with
  `# artifact` (runs as `<source> -> <view>`). Good when the dashboard needs
  helper views defined alongside it.
- **Compose existing views**: a model-level `## artifact { tiles=["a -> b", "c -> d"]
  dashboard_columns=6 }` (`##`, ONE line) names several views. Each tile runs as
  its own query (in parallel), and the results are combined into ONE
  `# dashboard` that Malloy's dashboard renderer lays out — so it looks exactly
  like the equivalent single-query dashboard: `dashboard_columns=N` sets the grid
  and `# colspan=N` / `# break` on the tile VIEWS place them. A tile that returns
  a SINGLE ROW with no group-by (an aggregate view) is merged in as top-level KPI
  tiles rather than a card (its `# colspan` is spread across those KPIs). The
  dashboard paints once the tiles are ready, with a single early paint if one tile
  straggles so a slow tile can't hold up the rest. Use for multi-tile /
  cross-source; prefer the inline query whenever a dashboard has its own filtering.
- A `dashboards/*.malloy` with NO `# artifact`/`## artifact` is a shared INCLUDE
  (skipped by discovery) — put helper sources/views there for several dashboards
  to import.

## Givens (filter controls)

Declare givens as `filter<T>` in the MODEL (`givens.malloy` or the source file) —
they're shared and used by the MCP surface too; each dashboard APPLIES them in
its `where:`. Full control reference: `yo_help dashboards/givens-and-controls`.
Per-dashboard starting values go in the tag:

```malloy
# artifact { title="Ford recalls" givens { MANUFACTURER=f'Ford Motor Company' } }
```

## Drill from a dimension

`# drill` on a source `dimension:` (in the model) makes its cells clickable —
opening another dashboard (seeding the value) or filtering in place:

```malloy
dimension:
  # drill { to=[category_explorer, self] }
  category is inventory_items.product_category
```

`to` is a list; each is a **dashboard slug** (a `dashboards/<slug>.malloy`
filename) → opens it, seeding the value into the given named like the dimension
UPPER-cased (`category` → `CATEGORY`), or **`self`** → filter the current
dashboard in place. Add `given=` when the target given differs. `lint` VERIFIES
every `to=` slug resolves to a real dashboard file (a typo/renamed dashboard
fails loudly, not at click time).

> **malloy#2979 (fixed in 0.0.423):** a `# drill` on a bare `group_by: name` was
> dropped when nested through `+ {…}`. Put it on the source `dimension:`, or use
> `group_by: name is concat(name,'')`.

## Custom component (optional)

For bespoke layout/charts, add a flat sibling `dashboards/<name>.jsx` (or
`.tsx`). Only React + `@malloyyo/dashboard` importable (sandboxed). A bare
`<Panel/>` renders the whole dashboard; a `<Panel query="…"/>` /
`<VegaChart query="…"/>` runs a query DEFINED in this dashboard file (by name) or
a `source -> view`. `lint` checks each `query="…"` still resolves. See `yo_help
dashboards/custom-components`.

## Rules
- Each dashboard is one `dashboards/<name>.malloy`; the filename is the slug.
  Prefer the inline `query: … # artifact` form — the `where: ~ $GIVEN` lives in
  the dashboard file.
- Bare-import the model (and/or `givens.malloy`) so the controls render.
- Givens are `filter<T>` declared in the model; options come from `# suggest {…}`;
  interactivity = setting given values, not rewriting query text.
- `index.malloy` is the data surface, NOT where dashboards live.
- If a query/given you need is missing, add it (check with `describe_source`).

## Preview & validate
`malloyyo dashboard dev` → open the URL; `.malloy`/`.jsx` edits hot-reload.
`malloyyo lint` checks each dashboard file on its own: it compiles as its entry;
each tile/query and `# suggest` compiles; `dashboard_columns` is a positive int;
the component compiles and its `query="…"` resolve; no duplicate names, no
orphaned component; every `# drill { to=… }` resolves. Tight loop: the local
`malloyyo mcp --develop` server hot-reloads edits — `query(execute:false)` to
compile-check, `execute:true` to run. Don't validate against a hosted/claude.ai
connector — it serves the PUBLISHED model (stale until `malloyyo publish`).
