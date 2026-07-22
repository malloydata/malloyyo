# Dashboards

A dashboard is a Malloy query with a tag on it. The filters, the layout, the
title, and the click-through targets all come out of the model — which means
there is no manifest to keep in sync, and most dashboards contain no JavaScript
at all.

Requires `@malloydata/malloy` 0.0.423 or later.

---

## One dashboard, one file

```
my-model/
  ecommerce.malloy       # sources, reusable views and measures, # drill tags
  givens.malloy          # given: declarations — the filter controls
  index.malloy           # imports/exports sources — the data surface ONLY
  dashboards/
    overview.malloy      # one dashboard; the FILENAME is its name
    overview.jsx         # optional custom component for overview
    seasonality.malloy
```

**The filename is the name** — its URL slug, its `# drill { to= }` target, and
the basename of its optional component all agree. Don't set `name=` in the tag;
one source of truth is the whole point.

**Dashboards are not declared in `index.malloy`.** Discovery globs
`dashboards/*.malloy` and compiles each as its own entry. `index.malloy` stays
one thing: the data surface that `query` and `describe_source` see.

A file in `dashboards/` with no `# artifact` tag is treated as a shared
**include** — a good home for helper sources several dashboards import.

## The declaration

```malloy
// dashboards/overview.malloy
##! experimental.givens
import "../ecommerce.malloy"          // BARE import: sources and givens in scope

#" Business health at a glance — sales, margin, orders.
# artifact { title="Business Overview" } dashboard {columns=6}
query: overview is order_items -> {
  where:
    inventory_items.product_brand ~ $BRAND,
    inventory_items.product_category ~ $CATEGORY,
    created_at ~ $PERIOD
  # colspan=2
  aggregate: total_sales, total_gross_margin, order_count
  # colspan=3
  nest:
    # break
    # line_chart
    sales_trend is by_month
    top_brands
    # shape_map
    sales_by_state
}
```

That is a complete dashboard. The runtime draws the title, a control for every
given the query references, the KPI tiles, and the card grid.

**Two tags, two jobs.** `# artifact` is Malloyyo's declaration — it says "this
query is a dashboard." `# dashboard {columns=6}` is Malloy's *renderer* tag — it
says how to draw the result. They're partners, usually on the same line, and
they are not interchangeable.

**Put the `where: … ~ $GIVEN` in the dashboard file.** That's how you know
you're doing it right. The model's sources and views stay reusable and
given-free; each dashboard decides its own filtering.

**The bare import is load-bearing.** A control renders only when the given's
*declaration* is in the dashboard file's scope. `import "../ecommerce.malloy"`
brings them all. A selective `import { order_items } from …` brings the source
but **not** the controls — the filter still applies, silently, with no way for
anyone to change it.

### Other forms

- **Tag a `view:`** you define in the dashboard file — it runs as
  `<source> -> <view>`. Useful when the dashboard needs helper views alongside
  it.
- **Compose existing views** with a model-level `## artifact { tiles=[…] }` (note
  the `##`, and keep it on one line). Each tile runs as its own query, in
  parallel, and the results combine into a single `# dashboard` layout. A tile
  that returns one row with no group-by is merged in as KPI tiles rather than a
  card. The dashboard paints once the tiles are ready, with an early paint if
  one straggles, so a slow tile can't hold the rest hostage. Use it for
  cross-source dashboards; prefer the inline query whenever a dashboard has its
  own filtering.

## Filters are givens

Declare givens once, in the model — they're shared, and the MCP surface uses
them too. Each dashboard applies the ones it wants:

```malloy
// givens.malloy
##! experimental.givens
given:
  # label="Brand" suggest { query=brand_suggest dimension=product_brand }
  BRAND :: filter<string> is f''
  # label="Category" control=select suggest { source=order_items dimension=product_category }
  CATEGORY :: filter<string> is f''
```

A given is typed `filter<T>`, so it holds a whole filter expression — `'CA'`,
`'CA, NY'`, `-'TX'`, `'[1980 to 1990]'` — and **empty means all**. That's why
`f''` is the right default for most filters: the dashboard opens unfiltered and
the user narrows.

The `#` tags on the declaration decide the control:

| tag | effect |
|---|---|
| `label="…"` | The control's label. |
| `control=select` | Single-select dropdown. |
| `control=multiselect` | Tokenized multi-select; each pick is a chip. |
| `range_min=` / `range_max=` | Numeric dual-thumb range slider. |
| `suggest { source=S dimension=D }` | Options from a source's dimension. |
| `suggest { query=Q dimension=D }` | Options from a named query — the preferred form. |

Anything else you tag passes through for a custom component to read.

The widget is chosen from the type and the tags: a numeric given with
`range_min`/`range_max` gets a range slider; a `filter<timestamp>` or
`filter<date>` gets a time range with presets; `control=multiselect` gets chips;
a suggest-backed `control=select` gets a dropdown; a boolean gets a checkbox;
everything else gets a search box.

### Suggestions and typeahead

Declaring a `dimension` in the suggest is what turns on **server-side
typeahead** — the runtime narrows the option list against the real column as the
user types, rather than fetching everything and filtering in the browser.

The **query form** buys you related filters. If the suggest query references the
*other* givens, the options track the current selections:

```malloy
query: brand_suggest is order_items -> {
  where: inventory_items.product_category ~ $CATEGORY
  group_by: product_brand is inventory_items.product_brand
  order_by: product_brand
}
```

Pick a category, and the brand list narrows to brands in it. The runtime runs
this with the other controls' current draft values, excluding the given being
suggested.

Suggestion queries run under the same restricted-query rules as everything else
— see [Governance](governance.md).

### Starting values

Per-dashboard starting values go in the tag, overriding the declaration's
default:

```malloy
# artifact { title="Ford recalls" givens { MANUFACTURER=f'Ford Motor Company' } }
```

Precedence at load: a URL parameter (`?$BRAND=…`) beats the tag's `givens{}`,
which beats the declaration default. That ordering is what makes a shared
dashboard URL reproduce exactly what the sender was looking at.

### Staging edits

By default a control change re-runs the query immediately. Add `autorun=false`
to stage them instead — edits accumulate and the controls bar grows **Apply**
and **Reset** buttons:

```malloy
# artifact { title="Births by name" autorun=false }
```

Worth it when the query is slow or the user typically changes several filters at
once.

## Layout

`# dashboard {columns=N}` puts the result on a fixed grid. Use `columns=6` — it
divides evenly into 2- and 3-wide cards.

**A tag above `aggregate:` or `nest:` applies to every item in that block**, so
you set widths once per block rather than per field:

- `# colspan=2` above `aggregate:` — three KPI tiles per row.
- `# colspan=3` above `nest:` — two charts per row.
- `# colspan=6` on one item — a wide detail table gets its own full-width row. A
  per-item colspan overrides the block default.
- `# break` on the first nest item — starts the charts on a fresh row so KPI
  tiles and charts never share one. Always add it: it's a no-op when the tiles
  already fill their rows, and the fix when they don't.

Per-item render tags (`# line_chart`, `# bar_chart`, `# shape_map`) go on the
individual nested items. `# colspan` does nothing without `{columns=N}` — the
default layout is free-flow wrap.

Full detail: `yo_help("dashboards/grid-layout")`.

## Drill

Put `# drill` on a source **dimension**, and every cell grouped by it becomes
clickable, everywhere it appears:

```malloy
dimension:
  # drill { to=[category_explorer, self] }
  category is inventory_items.product_category
```

Each destination is either a **dashboard slug** — opens that dashboard, seeding
the clicked value into the given named like the dimension, upper-cased
(`category` → `CATEGORY`) — or **`self`**, which filters the current dashboard in
place. Add `given=` when the target given has a different name. One destination
acts on click; two or more pop a menu.

`to=` is opaque tag text that Malloy never validates, which is why **`malloyyo
lint` checks every target resolves**. A renamed dashboard fails at lint, not at
click time.

## Custom components

Most dashboards don't need one. Add a flat sibling `dashboards/<name>.jsx` (or
`.tsx`) when you want bespoke layout or charts Malloy's render tags can't do.

The component runs sandboxed: React and `@malloyyo/dashboard` only, no network,
no credentials. Everything it needs arrives as props:

```jsx
// dashboards/overview.jsx
export default function Dashboard({ Panel, Controls, VegaChart, givens, useGiven }) {
  return (
    <>
      <Controls />
      <Panel />                                       {/* this dashboard */}
      <Panel query="order_items -> by_month" />       {/* a query in this file */}
    </>
  );
}
```

- A bare **`<Panel/>`** renders the whole dashboard. `<Panel query="…"/>` runs a
  query defined in this dashboard file by name, or a `source -> view`.
  `<Panel malloy="…"/>` runs ad-hoc Malloy, under the restricted-query rules.
- **`<Controls/>`** lays out a control for every given the dashboard references;
  `<Given name="BRAND"/>` places one individually, and `Select`, `Search`,
  `MultiSelect`, `Range`, `TimeRange`, and `Checkbox` are available if you want
  to pick the widget yourself.
- **`useGiven(name)`**, **`useQuery(req)`**, **`useOptions(name)`**, and
  **`runData(malloy)`** are the hooks, for reading and setting filter state and
  running queries.
- **`filters`** builds valid filter expressions — `filters.oneOf(…)`,
  `filters.between(lo, hi)`, `filters.lastN(n, units)`. Use it rather than
  concatenating strings; escaping matters, and `'Tesla, Inc.'` parses as two
  alternatives if you build it by hand.

`lint` transpiles the component and checks that every hard-coded `query="…"`
still resolves.

### Charts

For anything the `# bar_chart` / `# line_chart` / `# shape_map` tags can't do,
use the **`<VegaChart>`** component with a Vega-Lite spec. There is no
`# vega_lite` tag — it's a component, not a render tag:

```jsx
<VegaChart query="order_items -> sales_by_month" spec={{
  mark: "line",
  encoding: {
    x: { field: "month", type: "temporal" },
    y: { field: "total_sales", type: "quantitative" },
  },
}} />
```

The Vega engine is bundled into the runtime, so your dashboard ships only a JSON
spec. Specs are sanitized — every `url` and `loader` is stripped and data is
forced inline — and expressions run through Vega's AST interpreter rather than
`new Function`, so charts work under a strict content-security policy.

Details: `yo_help("dashboards/vega-charts")` and
`yo_help("dashboards/custom-components")`.

## Preview and validate

```bash
malloyyo dashboard dev      # live-reloading preview against your local model
malloyyo lint               # check every dashboard file
```

`dashboard dev` serves the trusted shell and the untrusted artifact document on
two ports, so the origin boundary matches production. Tag-only dashboards render
in the page; custom ones run in the sandboxed iframe.

**Validate against the local server, not a hosted connector.** A claude.ai
connector serves the *published* model, which is stale until you
`malloyyo publish`. The local `malloyyo mcp --develop` server hot-reloads your
edits.

See [Testing a model](testing.md) for what `lint` checks and why each check
exists.

---

**Next:** [Publishing](publishing.md)
