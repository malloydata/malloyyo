# Creating dashboards in Malloyyo

A Malloyyo dashboard is **declared entirely in your Malloy model**. There is no
manifest file, no JSON config, and — for the common case — no JavaScript. You
tag a query with `# artifact`, tell it how to lay out with `# dashboard`,
declare a few *givens* (interactive filters), and export it all through
`index.malloy`. The runtime draws the KPI tiles, cards, and filter controls for
you.

This guide walks through each piece:

1. [`# artifact` — declaring a dashboard](#1--artifact--declaring-a-dashboard)
2. [`# dashboard {columns=N}` — the grid layout](#2--dashboard-columnsn--the-grid-layout)
3. [Givens — interactive filters](#3-givens--interactive-filters)
4. [`# drill` — click a value to navigate or filter](#4--drill--click-a-value-to-navigate-or-filter)
5. [Exporting through `index.malloy` — the contract](#5-exporting-through-indexmalloy--the-contract)
6. [Preview & validate](#6-preview--validate)

Throughout, the running example is an ecommerce model whose source is
`order_items`.

---

## 1. `# artifact` — declaring a dashboard

A dashboard is a **query tagged `# artifact`**. The idiomatic form is to tag a
`view:` inside a source (a view is reusable, nestable, and explorable through
the normal query surface):

```malloy
source: order_items is duckdb.table('order_items.parquet') extend {
  #" Business health at a glance — sales, margin, orders.
  # artifact { title="Business Overview" }
  view: overview_dashboard is {
    aggregate: total_sales, total_gross_margin, order_count
    nest:
      sales_trend is by_month
      top_brands
      sales_by_state
  }
}
```

That is already a complete dashboard. The runtime renders a **title** (the tag's
`title=`, or else the `#"` doc comment), a **control for every given the view
references** (none yet — we add those below), and the **result panel**. It runs
as `run: order_items -> overview_dashboard`.

**`# artifact` tag options:**

| Key | Meaning |
| --- | --- |
| `title="…"` | Dashboard title shown at the top. Falls back to the `#"` doc comment. |
| `name="slug"` | Overrides the URL / directory slug. Defaults to the view name. |
| `givens { X="…" }` | Per-dashboard starting values for givens (see [§3](#3-givens--interactive-filters)). |
| `autorun=false` | Batch filter changes behind an **Apply** button instead of re-running live on every change. |

**Where the tag can live:**

- On a **`view:` inside a source** (preferred) — it rides along with the source
  when you export the source, and runs as `run: <source> -> <view>`.
- On a **top-level `query:`** — behaves identically, runs as `run: <name>`.
  Reach for this only when the dashboard query doesn't belong to any one source.

You can't export a view on its own — you export its **source**, and the view
travels with it. This matters for [exporting](#5-exporting-through-indexmalloy--the-contract).

### `# dashboard` — render it *like* a dashboard

`# artifact` *declares* a dashboard; `# dashboard` is the **renderer tag** that
draws it as **KPI tiles + a card grid** instead of one flat table. They are
partners — for the common overview shape (top-level aggregates + nests), use
both:

```malloy
# artifact { title="Business Overview" } dashboard
view: overview_dashboard is { … }
```

Without `# dashboard`, an `# artifact` query still renders — just as the default
Malloy table/nest result rather than a tiled dashboard.

---

## 2. `# dashboard {columns=N}` — the grid layout

By default a `# dashboard` result flows its tiles and cards and wraps them. Add
`{columns=N}` to place everything on a **fixed N-column grid**. Use `columns=6`
— it divides evenly into 2- and 3-wide cards.

**Key mechanic:** a layout tag placed **above** an `aggregate:` or `nest:` block
applies to **every item** in that block. So you set widths once per block, not
per field.

```malloy
#" Business health at a glance — sales, margin, orders.
# artifact { title="Business Overview" } dashboard {columns=6}
view: overview_dashboard is {
  # colspan=2
  aggregate: total_sales, total_gross_margin, order_count, average_order_value

  # colspan=3
  nest:
    # break
    # line_chart
    sales_trend is by_month
    top_brands
    # shape_map
    sales_by_state
    # colspan=6
    recent_orders                 // wide detail table → full width
}
```

The layout tags:

- **`# colspan=2` above `aggregate:`** — each KPI tile spans 2 of 6 columns → 3
  tiles per row.
- **`# colspan=3` above `nest:`** — each chart / small table spans 3 → 2 per row.
- **`# colspan=6`** on a single item — a wide, many-column table gets its own
  full-width row. A per-item `# colspan` overrides the block default.
- **`# break` on the first nest item** — starts the charts on a fresh row so KPI
  tiles and charts never share one. It's a no-op when the tiles already fill
  complete rows, so just always add it.

Per-item **render tags** (`# line_chart`, `# bar_chart`, `# shape_map`) go on
the individual nested items, as shown.

> `# colspan` only does anything in `{columns=N}` mode. Without it, the layout
> is free-flow wrap and colspan is ignored. Keep colspans in `1..N`.

---

## 3. Givens — interactive filters

**A "given" is a named, typed input to a dashboard** — it's what makes the
dashboard interactive. Each given becomes a **filter control** (a search box,
dropdown, slider, date picker, or checkbox) at the top of the dashboard. When
the user changes a control, the dashboard re-runs with the new value.

You declare givens with a `given:` block, then reference them inside your
dashboard's `where:` clause. There are two halves:

### Declaring the givens

Givens are **`filter<T>` values**, never raw strings or numbers. A `filter<T>`
is a little query language of its own, which is what lets one control express
"one value", "several", "a wildcard", "a range", "the last 7 days", and so on:

| Type | Accepts |
| --- | --- |
| `filter<string>` | one value (`'NY'`), alternatives (`'NY, CA'`), wildcards (`'Ann%'`), negation (`'-NY'`) |
| `filter<number>` | ranges (`'[1910 to 1930]'`), comparisons (`'> 200'`) |
| `filter<timestamp>` / `filter<date>` | relative windows (`'7 days'`, `'today'`, `'last month'`) and literal ranges (`'2026-01-01 to 2026-07-01'` — **no `@`** in filter literals) |

You write a filter literal with the `f'…'` syntax. **`f''` (empty) means no
filter** — the natural "All" / "all time". This is the clean way to express
"unset": just `col ~ $X`, no `$X = '' or …` dance.

```malloy
##! experimental { givens }

given:
  # label="Brand" suggest { query=brand_suggest dimension=product_brand }
  BRAND :: filter<string> is f''

  # label="Category" control=select suggest { source=order_items dimension=product_category }
  CATEGORY :: filter<string> is f''

  # label="Time period"
  PERIOD :: filter<timestamp> is f''

  # label="Price range" range_min=0 range_max=500
  PRICE_RANGE :: filter<number> is f''
```

### Applying the givens

Reference the given with `$NAME` and apply it with the match operator `~` inside
the dashboard's `where:`. **Multiple conditions are COMMA-separated** — newline
separation does not parse:

```malloy
# artifact { title="Business Overview" } dashboard {columns=6}
view: overview_dashboard is {
  where:
    inventory_items.product_brand ~ $BRAND,        // comma
    inventory_items.product_category ~ $CATEGORY,  // comma
    created_at ~ $PERIOD                            // one condition per given
  # colspan=2
  aggregate: total_sales, total_gross_margin, order_count
  …
}
```

Because `f''` matches everything, an unset filter simply doesn't constrain the
result.

### The control tags

The `#` tags on each given's **declaration** drive its control (tag syntax is
`key="value"` — equals, not colon):

- **`label="…"`** — the control's caption (defaults to the given's name).
- **`suggest { … }`** — where the control's option list comes from:
  - `suggest { query=brand_suggest dimension=product_brand }` — the first column
    of a **named query** you declare in the model. **Prefer this form** — only
    that one query needs exporting, and it's governed and reviewable.
  - `suggest { source=order_items dimension=product_category }` — the distinct
    values of a dimension on a source (the whole source must be exported).

  Naming a `dimension` in either form enables **server-side typeahead**: as the
  user types, the runtime refines the query (`… + { where: lower(field) ~ f'll%'
  }`, case-insensitive, escaped). Without a `dimension`, the list is filtered
  client-side.
- **`control=select`** — a fixed dropdown instead of a typeahead search box.
- **`control=multiselect`** — a tokenized multi-select for a `filter<string>`;
  each pick is a removable chip, committed as an exact-match list.
- **`range_min=` / `range_max=`** — bounds that turn a `filter<number>` given
  into a dual-thumb range slider.

The runtime picks a sensible control automatically from the type: numeric range
tags → slider; `filter<timestamp|date>` → the TimeRange widget (Today / Last 7
days / Last 30 days / … plus a custom from/to picker); `boolean` → checkbox;
`suggest + control=select` → dropdown; otherwise a committing search box with
typeahead.

### Related (faceted) filters

With the **query form** of `suggest`, a suggestion query can reference the
*other* givens, and the runtime runs it with the dashboard's current values — so
Brand suggestions narrow once Category is set. Declare one `*_suggest` query per
filter, each referencing the others (the given being suggested is
auto-excluded, so its own list never collapses):

```malloy
query: brand_suggest is inventory_items -> product_brand + {
  where:
    product_category ~ $CATEGORY,      // reference the OTHER givens
    product_department ~ $DEPARTMENT
  limit: 500
}
```

The `f''` defaults mean unset filters don't constrain. `source=` suggests can't
do this (no place for a `where:`) — another reason to prefer `query=`.

### Live vs. Apply

By default a dashboard is **live**: every control change re-runs the query
immediately. Set `autorun=false` on the `# artifact` tag to batch changes behind
an **Apply** button instead — good when the query is expensive or several
filters usually change together.

### Per-dashboard starting values

Two dashboards can share a given but start on different values. A `givens` block
**in the `# artifact` tag** sets per-dashboard defaults (URL params still win):

```malloy
# artifact { name="manufacturer" title="Manufacturer Profile" givens { BRAND="Ford Motor Company" } }
view: manufacturer_dashboard is { … }
```

Declare the given once with a neutral default (usually `f''` = no filter), and
let each dashboard tag pick its own landing state.

---

## 4. `# drill` — click a value to navigate or filter

`# drill` makes a **dimension's cells clickable**. Clicking a value either
navigates to another dashboard (seeding the clicked value as a filter) or
filters the current dashboard in place. It goes on the **dimension** — not on
`# link` (that's for external URLs) — so it works everywhere that dimension is
grouped.

```malloy
dimension:
  # drill { to=[category_dashboard, self] }
  category is inventory_items.product_category

  # drill { to=[brand_dashboard] }
  brand is inventory_items.product_brand
```

`to` is a list of destinations, each either:

- **a target `# artifact` slug** → opens that dashboard, seeding the clicked
  value into its given named like the dimension **upper-cased** (`category` →
  `CATEGORY`) as an exact-match filter, or
- **the keyword `self`** → sets that same given on the **current** dashboard
  (filter in place, no navigation). Offered only if the current dashboard
  declares the given.

One destination acts immediately on click; two or more pop a small menu at the
cursor. Drillable cells get a pointer cursor and highlight on hover. Measure /
aggregate cells never drill. Navigation is same-tab (Back returns).

### Naming the target given explicitly (`given=`)

If the destination's given is **not** just the dimension upper-cased, add
`given=` to override the name — for every `to` in this tag, including `self`:

```malloy
dimension:
  # drill { to=[state_dashboard, self] given=STATE_CODE }
  state is orders.ship_state
```

Clicking `state` now seeds `STATE_CODE` rather than `STATE`. One given per drill
tag; to map several givens, use separate `# drill` tags on separate dimensions.

> **Caveat (malloy#2979):** a `# drill` on a **bare** `group_by: name` is dropped
> when that view is nested through a `+ {…}` refinement. Put the tag on the
> source `dimension:` (it survives refinement), or make the grouped field an
> expression: `group_by: name is concat(name, '')`.

---

## 5. Exporting through `index.malloy` — the contract

**The entry point is `index.malloy`.** `dashboard dev`, `lint`, and the hosted
server only see what that file **exports**. If you don't have one,
`malloyyo init` scaffolds one that re-exports your models.

Three things must **each** be imported *and* exported through `index.malloy`, or
the dashboard looks broken even though the model compiles clean:

1. **Whatever holds each `# artifact` tag.** A tag on a `view:` rides with its
   **source** (export the source — you can't export a view alone). A tag on a
   top-level `query:` needs that **query** exported.
   *Not surfaced →* `dashboard dev` says "No dashboards declared" and `lint` says
   "no dashboards to lint".
2. **Every filter given the dashboards reference.**
   *Not surfaced →* the given silently resolves to its declaration default: the
   control still renders but **can't change the query** (the filter looks inert).
3. **Whatever backs each `suggest`** — the named query (`suggest {query=…}`) or
   source (`suggest {source=…}`).
   *Not surfaced →* lint fails with "Reference to undefined object".

```malloy
##! experimental.givens
import {
  order_items,                    // the source — carries its # artifact views
  BRAND, CATEGORY, PERIOD,        // the filter givens
  brand_suggest                   // backs a suggest { query=… }
} from 'ecommerce.malloy'

export { order_items, BRAND, CATEGORY, PERIOD, brand_suggest }
```

Exporting the **source** is often the whole job: its `# artifact` views, its
dimensions (for `suggest {source=…}`), and its measures all travel with it. You
mainly need to add givens and any named suggest queries alongside it.

---

## 6. Preview & validate

```bash
malloyyo dashboard dev      # opens a live preview; edits to .malloy hot-reload
malloyyo lint               # validates tagged queries, suggest declarations, layout
```

- Edits to your `.malloy` (tags, givens, queries) hot-reload in `dashboard dev`.
- `lint` only checks dashboards **reachable from the entry** — "no dashboards to
  lint" almost always means the `# artifact` queries aren't exported through
  `index.malloy` (see [§5](#5-exporting-through-indexmalloy--the-contract)), not
  that they don't exist. As of the latest CLI, `lint` also **warns when a
  dashboard filters on a given that `index.malloy` doesn't export** — the exact
  case that makes a control look inert.
- For a tight edit loop, the local `malloyyo mcp --develop` server hot-reloads
  working-directory edits: `query(execute:false)` to compile-check,
  `execute:true` to run.

> Don't validate local edits against a hosted / claude.ai connector — that serves
> the **published** model, which is stale until `malloyyo publish`.

Once it looks right locally, `malloyyo publish` pushes the model (and its
dashboards) to the hosted instance.

---

## Beyond the basics

The auto-rendered controls + panel cover most dashboards. When you need more:

- **Custom charts** the `#` renderer tags can't do → the `<VegaChart>` component
  (a Vega-Lite spec over query rows) in a custom `Dashboard.tsx`. There is no
  `# vega_lite` tag. See `yo_help dashboards/vega-charts`.
- **Bespoke layout / copy / theming** → one `./dashboards/<slug>/Dashboard.tsx`
  that composes the runtime's widgets (`<Controls>`, `<Given>`, `<Search>`,
  `<Select>`, `<TimeRange>`, `<Panel>`) and hooks with your own React. Only
  React + `@malloyyo/dashboard` are importable — the runtime sandboxes it. See
  `yo_help dashboards/custom-components`.

These `yo_help` topics (surfaced over MCP) and the `docs/repo-artifacts.md`
design doc go deeper than this guide.
```