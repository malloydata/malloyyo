---
description: How to author a dashboard — declared in the model via # artifact tags, surfaced through index.malloy; the entry point for dashboard how-to
---

# Authoring dashboards

A dashboard is DECLARED IN THE MODEL — there is no manifest file and, for the
basic case, no JavaScript at all. Preview with `malloyyo dashboard dev`; check
with `malloyyo lint`.

Related topics: `yo_help dashboards/givens-and-controls` (the filter controls),
`dashboards/grid-layout` (columns/colspan/break), `dashboards/custom-components`
(a custom `Dashboard.tsx`), `dashboards/vega-charts` (`<VegaChart>`).

> **Need a chart the `# bar_chart`/`# line_chart`/`# shape_map` renderer tags
> can't do?** Use the `<VegaChart>` COMPONENT (a Vega-Lite spec over query
> rows) in a custom `Dashboard.tsx` — NOT a `#` tag; there is no
> `# vega_lite`. See `yo_help dashboards/vega-charts`.

## Make dashboards discoverable: the entry model

**The entry is `index.malloy`.** `dashboard dev`, `lint`, and the hosted
server only see what that file EXPORTS. (No `index.malloy` yet? `malloyyo init`
scaffolds one that re-exports the repo's models.) Three things must all be
surfaced (imported AND exported) through it, or the feature looks broken:

1. **Whatever holds each `# artifact` tag.** A tag on a `view:` rides along
   with its SOURCE (export the source — you can't export a view on its own); a
   tag on a top-level `query:` needs that query exported. Not surfaced →
   `dashboard dev` says "No dashboards declared" and `lint` says "no dashboards
   to lint", even though the model compiles clean.
2. **Every filter given the dashboards reference.** An unexported given
   silently resolves to its declaration default — the control still renders
   but CAN'T CHANGE THE QUERY (the filter looks inert).
3. **Whatever backs each `suggest`** — the named query (`suggest {query=…}`)
   or source (`suggest {source=…}`). Suggestions run against the entry model;
   an unexported one fails lint with "Reference to undefined object".

```malloy
##! experimental.givens
import {
  order_items,                      // the source — carries its # artifact views
  BRAND, CATEGORY, PERIOD,          // the filter givens
  brand_suggest                     // backs a suggest {query=…}
} from 'ecommerce.malloy'
export { order_items, BRAND, CATEGORY, PERIOD, brand_suggest }
```

Exporting the source is often the whole job: its `# artifact` views, its
dimensions (for `suggest {source=…}`), and its measures all travel with it.

## The model is the whole contract

**1. Tag a `view:` inside a source** with `# artifact` to declare a dashboard
(the idiomatic form — a view is reusable, nestable, and explorable through the
normal `query`/`describe_source` surface). For the common overview shape
(top-level aggregates + nests), ALSO tag it `# dashboard` so the result
renders as KPI tiles + a card grid instead of one flat table — they're
partners: `# artifact` declares the dashboard, `# dashboard` is the renderer
tag that draws it like one:

```malloy
source: order_items is … extend {
  #" Business health at a glance — sales, margin, orders.
  # artifact { title="Business Overview" } dashboard {columns=6}
  view: overview_dashboard is {
    where:
      inventory_items.product_brand ~ $BRAND,     // multi-filter where: is
      inventory_items.product_category ~ $CATEGORY,  // COMMA separated
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
}
```

That's a complete dashboard: the runtime auto-renders a title (the tag's
`title`, else the `#"` doc comment), a control for every given the view
references, and the result panel. It runs as `run: <source> -> <view>` (here
`order_items -> overview_dashboard`). `name="slug"` overrides the
URL/directory slug (default: the view name). Note the `where:` clauses
applying givens are COMMA-separated — newline-separated conditions do not
parse.

**Grid layout** — the `dashboard {columns=6}` + `# colspan` / `# break` tags
above place the KPI tiles and cards on a grid. Full rules: `yo_help
dashboards/grid-layout`.

Tagging a **top-level `query:`** still works and behaves identically (it runs
as `run: <name>`) — reach for it only when the dashboard query doesn't belong
to any one source.

**Deep-link a cell** to an external system — tag any `group_by:`/`select:`
field `# link` (the value is a full URL) or
`# link { url_template="https://…/$$" }` (`$$` = the cell value; add
`field=id` to link on a separate, usually `# hidden`, id column). Common in a
nested detail table so each row jumps to its record. `# image { url_template=… }`
renders a cell as an inline image. Links open in a new browser tab.

**Drill from a dimension** into another dashboard (or filter in place) with
`# drill` on the DIMENSION — not `# link` (that's for external URLs). Drill is a
property of the dimension, so it works everywhere that dimension is grouped:

```malloy
dimension:
  # drill { to=[category_dashboard, self] }
  category is inventory_items.product_category
  # drill { to=[brand_dashboard] }
  brand is inventory_items.product_brand
```

`to` is a list of destinations; each is either a target `# artifact` slug or the
keyword **`self`**. Clicking a dimension cell:
- **slug** → opens that dashboard, seeding the clicked value into its given named
  like the dimension **upper-cased** (`category` → `CATEGORY`) as an exact-match
  filter.
- **`self`** → sets that same given on the CURRENT dashboard (filter in place, no
  navigation). Offered only if this dashboard actually declares the given.

One destination acts immediately; two or more pop a small menu at the cursor.
Drillable cells get a pointer cursor and turn the accent color on hover (the web
app's clickable-item look) so users can see they're clickable. Measure/aggregate
cells never drill. Navigation is SAME-tab (Back returns), and
the runtime resolves the URL for wherever it runs — hosted
`/datasets/:id/dashboard/:slug` or the local `dashboard dev` preview — so the
model needs no host/dataset knowledge. Given values ride the URL `$`-prefixed
(`?$CATEGORY=Books`); bare params are reserved for future dimension filters.

> **malloy#2979 caveat:** a `# drill` written on a *bare* `group_by: name` is
> dropped when that view is nested through a `+ {…}` refinement. Put it on the
> source `dimension:` (survives refinement), or make the grouped field an
> expression — `group_by: name is concat(name,'')`.

Two dashboards can share a given but start on different values — a `givens`
block in the tag sets PER-DASHBOARD defaults (given values, i.e. filter
expressions; URL params still win):

```malloy
# artifact { name="manufacturer" title="Manufacturer Recall Profile" givens { MANUFACTURER="Ford Motor Company" } }
```

This replaces the "declare the given's default per dashboard" role the old
manifests had: declare the given once with a neutral default (often `f''` =
no filter), and let each tag pick its landing state.

**2. Declare the filters as `filter<T>` givens** with their control tags — see
`yo_help dashboards/givens-and-controls`. **3. (optional) Add a custom
`Dashboard.tsx`** for bespoke layout/charts — see `yo_help
dashboards/custom-components`.

## Rules
- Declare data in the model: givens are `filter<T>`, options come from
  `# suggest {…}` declarations, dashboards are `# artifact` tags. If a query or given you
  need is missing, add it to the `.malloy` file first (check with
  `describe_source`).
- Surface everything through the entry model (see "Make dashboards
  discoverable" above).
- Only React + `@malloyyo/dashboard` are importable in a `Dashboard.tsx`. No
  other imports, no network — the runtime sandboxes the component.
- Interactivity = setting given values (filter-expression strings), not
  rewriting query text per interaction.

## Preview & validate
`malloyyo dashboard dev` → open the printed URL. Edits to `.malloy` (tags,
givens, queries) and `Dashboard.tsx` hot-reload. `malloyyo lint` validates
the tagged queries, given `suggest` declarations, and any Dashboard.tsx —
but only for dashboards REACHABLE FROM THE ENTRY: "no dashboards to lint"
usually means the `# artifact` queries aren't exported through
`index.malloy`, not that they don't exist.

Validation loop that works well: the local `malloyyo mcp --develop` server
hot-reloads working-directory edits — `query(execute:false)` to compile-check,
`execute:true` to run. A `# artifact` view runs as
`run: <source> -> <view>`; a top-level `# artifact` query runs as
`run: <name>`. Either is only visible once surfaced through the entry (export
the source for a view, the query for a top-level query). Don't validate local
edits against a hosted/claude.ai connector — that serves the PUBLISHED model,
which is stale until `malloyyo publish`.
