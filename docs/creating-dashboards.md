# Creating dashboards in Malloyyo

> **Superseded by [Dashboards](guide/dashboards.md)** in the user guide, which
> is the maintained version. This page is still accurate on the current
> structure and goes deeper in places (the full `# artifact` tag options); keep
> it for reference, but make edits to the guide.

A Malloyyo dashboard is a **self-contained `.malloy` file in the `dashboards/`
directory**. The file *is* the dashboard: it imports the parts of your model it
needs, defines its query (with the filtering it applies), and tags it. There's
no manifest, no JSON config, and — for the common case — no JavaScript. The
runtime draws the KPI tiles, cards, and filter controls for you.

```
your-model/
  malloy-config.json
  ecommerce.malloy       # sources, reusable views/measures, # drill tags
  givens.malloy          # given: declarations (the filter controls)
  index.malloy           # imports/exports your sources — the MCP/data surface
  dashboards/
    overview.malloy      # one dashboard — imports the model, declares its query
    overview.jsx         # optional custom component for THIS dashboard
    seasonality.malloy
```

**The filename is the dashboard's name** — its URL slug, its `# drill` target,
and the basename of its optional component. `dashboards/overview.malloy` →
dashboard `overview`.

Requires **`@malloydata/malloy` 0.0.423+** (earlier versions drop annotations,
including `# drill`, on refined nests).

This guide:

1. [Declaring a dashboard](#1-declaring-a-dashboard)
2. [`# dashboard {columns=N}` — the grid layout](#2--dashboard-columnsn--the-grid-layout)
3. [Givens — interactive filters](#3-givens--interactive-filters)
4. [`# drill` — click a value to navigate or filter](#4--drill--click-a-value-to-navigate-or-filter)
5. [Custom components](#5-custom-components)
6. [`index.malloy` and lint](#6-indexmalloy-and-lint)

---

## 1. Declaring a dashboard

### The preferred form — put the query IN the dashboard file

Define the query **right in `dashboards/<name>.malloy`** and tag it `# artifact`.
This is the preferred style because **the given mapping is visible in one
place** — the `where: … ~ $GIVEN` that maps each control to what it filters lives
next to the dashboard it belongs to.

```malloy
// dashboards/overview.malloy
##! experimental.givens
import "../ecommerce.malloy"          // bare import: source + givens both in scope

#" Business health at a glance — sales, margin, orders.
# artifact { title="Business Overview" } dashboard {columns=6}
query: overview is order_items -> {
  where:                                             // ← the given mapping, here
    inventory_items.product_brand ~ $BRAND,          //   COMMA-separated
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

That's a complete dashboard. The runtime auto-renders a **title** (the tag's
`title=`, else the `#"` doc comment), a **control for every given the query
references**, and the **result panel**.

> **You know you're doing it right when the `where: foo ~ $FOO` is in the
> dashboard file, not the model.** Keep the model's sources and views reusable
> and given-free; each dashboard decides its own filtering.

### The bare import brings the controls

A control renders only when the given's *declaration* is in the dashboard file's
scope. A **bare** `import "../ecommerce.malloy"` (or `import "../givens.malloy"`)
pulls in every declaration, and the runtime shows a control for exactly the
givens the query references — no enumerating. (A selective `import { order_items }
from …` brings the filter but *not* the control.)

### `# artifact` tag options

| Key | Meaning |
| --- | --- |
| `title="…"` | Dashboard title. Falls back to the `#"` doc comment. |
| `givens { X=f'…' }` | Per-dashboard starting values for the controls ([§3](#per-dashboard-starting-values)). |
| `autorun=false` | Batch filter changes behind an **Apply** button instead of re-running live. |

The dashboard's **name is the filename** — don't set a `name=`; keeping filename
= name means one source of truth (the URL, the `# drill { to=… }`, and the
component basename all agree).

### `# dashboard` — render it *like* a dashboard

`# artifact` *declares* the dashboard; `# dashboard` is the **renderer tag** that
draws it as KPI tiles + a card grid instead of one flat table (§2). They're
partners — for an overview shape (top-level aggregates + nests) use both, on the
same line: `# artifact { title="…" } dashboard {columns=6}`.

### Other forms

- **A view of a source you extend in the file.** If the dashboard wants helper
  views, define a source extension in the dashboard file and tag the dashboard
  view:
  ```malloy
  # artifact { title="Over-represented names" }
  view: overrepresented is baby_names_over -> { nest: male is …; nest: female is … }
  ```
- **Compose existing views** (`## artifact { tiles }`) — a **model-level**
  annotation (`##`, one line) that names several existing views as tiles, run
  separately and combined into one `# dashboard`. Use it for multi-tile /
  cross-source dashboards; prefer the inline query above whenever a dashboard has
  its own filtering.
  ```malloy
  ## artifact { title="Overview" tiles=["orders -> by_month", "users -> signups"] dashboard_columns=6 }
  ```
- A `dashboards/*.malloy` with **no** `# artifact`/`## artifact` is treated as a
  shared **include** (skipped by discovery) — a place to put helper sources/views
  imported by several dashboard files.

---

## 2. `# dashboard {columns=N}` — the grid layout

By default a `# dashboard` result flows its tiles and cards and wraps. Add
`{columns=N}` for a fixed N-column grid — use `columns=6` (divides evenly into 2-
and 3-wide cards).

**Key mechanic:** a layout tag placed **above** an `aggregate:` or `nest:` block
applies to **every item** in that block — set widths once per block.

- **`# colspan=2` above `aggregate:`** — each KPI tile spans 2 of 6 → 3 per row.
- **`# colspan=3` above `nest:`** — each chart/small table spans 3 → 2 per row.
- **`# colspan=6`** on one item — a wide table gets its own full-width row (a
  per-item colspan overrides the block default).
- **`# break` on the first nest item** — starts the charts on a fresh row so KPI
  tiles and charts never share one (a no-op when tiles already fill rows, so
  always add it).
- Per-item **render tags** (`# line_chart`, `# bar_chart`, `# shape_map`) go on
  the individual nested items.

`# colspan` only does anything in `{columns=N}` mode; keep colspans in `1..N`.
Full rules: `yo_help dashboards/grid-layout`.

---

## 3. Givens — interactive filters

A **given** is a named, typed input to a dashboard — each becomes a filter
control (search box, dropdown, slider, date picker, checkbox) at the top. When
the user changes a control, the dashboard re-runs.

**Declarations live in the model** (a `givens.malloy`, or the source file) —
they're a semantic concern (views reference them, the MCP surface uses them),
shared across dashboards. Each **dashboard applies** them in its own `where:`.

### Declaring the givens

Givens are **`filter<T>`** values (never raw strings/numbers). `f''` (empty) =
no filter — the natural "All":

```malloy
// givens.malloy
##! experimental.givens
given:
  # label="Brand" suggest { query=brand_suggest dimension=product_brand }
  BRAND :: filter<string> is f''
  # label="Category" control=select suggest { source=order_items dimension=product_category }
  CATEGORY :: filter<string> is f''
  # label="Time period"
  PERIOD :: filter<timestamp> is f''
```

| Type | Accepts |
| --- | --- |
| `filter<string>` | one value (`'NY'`), alternatives (`'NY, CA'`), wildcards (`'Ann%'`), negation (`'-NY'`) |
| `filter<number>` | ranges (`'[1910 to 1930]'`), comparisons (`'> 200'`) |
| `filter<timestamp\|date>` | relative windows (`'7 days'`, `'today'`) and literal ranges (`'2026-01-01 to 2026-07-01'` — **no `@`**) |

Control tags on the declaration drive the widget — `label=`, `control=select`,
`control=multiselect`, `range_min=`/`range_max=`, and `suggest { … }` for the
option list. Full reference: `yo_help dashboards/givens-and-controls`.

### Applying the givens (in the dashboard)

Reference with `$NAME` and apply with `~` in the dashboard query's `where:`.
**Conditions are COMMA-separated** — newlines don't parse:

```malloy
where:
  inventory_items.product_brand ~ $BRAND,
  created_at ~ $PERIOD
```

Because `f''` matches everything, an unset filter simply doesn't constrain.

### Per-dashboard starting values

Two dashboards can share a given but start on different values. A `givens` block
in the `# artifact` tag sets this dashboard's landing state (URL params win):

```malloy
# artifact { title="Ford recalls" givens { MANUFACTURER=f'Ford Motor Company' } }
```

---

## 4. `# drill` — click a value to navigate or filter

`# drill` makes a dimension's cells clickable — clicking navigates to another
dashboard (seeding the value as a filter) or filters in place. It goes on the
**source `dimension:`** (in the model), so it works everywhere that dimension is
grouped:

```malloy
// ecommerce.malloy
dimension:
  # drill { to=[category_explorer, self] }
  category is inventory_items.product_category
```

`to` is a list of destinations, each either:

- **a dashboard slug** (a `dashboards/<slug>.malloy` filename) → opens that
  dashboard, seeding the clicked value into its given named like the dimension
  **upper-cased** (`category` → `CATEGORY`); or
- **`self`** → sets that given on the current dashboard (filter in place).

Add `given=` when the destination's given isn't the dimension upper-cased. One
destination acts on click; two+ pop a menu.

Because the target is a filename string Malloy never checks, **`lint` verifies
every `# drill { to=… }` resolves to a real dashboard file** — a typo or a
renamed dashboard fails loudly instead of dead-ending at click time.

> **malloy#2979 caveat (fixed in 0.0.423):** older Malloy dropped a `# drill` on
> a bare `group_by: name` when nested through a `+ {…}` refinement. Put the tag
> on the source `dimension:`, or make the field an expression:
> `group_by: name is concat(name,'')`.

---

## 5. Custom components

The auto-rendered controls + panel cover most dashboards. For bespoke layout,
copy, theming, or a chart the `#` renderer tags can't do, add a flat sibling
`dashboards/<name>.jsx` (or `.tsx`). It composes the runtime's widgets and hooks
with your own React — only React + `@malloyyo/dashboard` are importable (the
runtime sandboxes it):

```jsx
// dashboards/overview.jsx
import { Controls, Search, VegaChart } from "@malloyyo/dashboard";

// A custom component draws the data itself — there is no `<Panel>` / Malloy
// renderer in the sandbox (`Panel` is not exported; importing it fails to bundle).
export default function Dashboard({ dashboard, givens }) {
  return (
    <>
      <Controls><Search given="BRAND" /></Controls>
      <VegaChart spec={spec} query="overview" givens={givens} />   {/* the inline query, by name */}
    </>
  );
}
```

- **Adding a component opts the dashboard OUT of the Malloy renderer** — you draw
  the results. Want the renderer back? Delete the component and let the tag render
  it. `<VegaChart query="…"/>` / `useQuery({query:"…"})` runs a specific query
  **defined in this dashboard file** (by name, e.g. `"overview"`) or any
  `source -> view`.
- `lint` checks each component's `query="…"` still resolves — a component
  pointing at a renamed/removed query fails, not silently blank.
- For `<VegaChart>` (a Vega-Lite spec over query rows) there is **no `# vega_lite`
  tag** — it's a component. See `yo_help dashboards/vega-charts` and
  `dashboards/custom-components`.

---

## 6. `index.malloy` and lint

`index.malloy` is **just your data/MCP surface** — it imports and exports your
sources for the `query`/`describe_source` tools. **Dashboards are NOT declared or
exported there**; discovery globs `dashboards/*.malloy`. So `index.malloy` stays
small:

```malloy
// index.malloy
import { order_items } from 'ecommerce.malloy'
export { order_items }
```

### Preview & validate

```bash
malloyyo dashboard dev      # live preview; edits to .malloy / .jsx hot-reload
malloyyo lint               # validate every dashboards/*.malloy
```

`lint` checks each dashboard file **on its own**, loudly and locally:

- the file compiles as its own entry (an undefined tile/query, a missing import,
  or an unresolved given fails at its line);
- each tile/query compiles, each given's `# suggest` compiles, `dashboard_columns`
  is a positive int;
- the optional component compiles **and** every `query="…"` it hard-codes
  resolves;
- no duplicate names, no orphaned component, and **every `# drill { to=… }`
  resolves to a real dashboard**.

Publish with `malloyyo publish <target>` once it looks right locally. (Don't
validate local edits against a hosted/claude.ai connector — that serves the
*published* model, stale until you publish.)

---

Deeper `yo_help` topics (over MCP): `dashboards/authoring`,
`dashboards/givens-and-controls`, `dashboards/grid-layout`,
`dashboards/vega-charts`, `dashboards/custom-components`. Design notes:
`docs/composite-dashboards.md`, `docs/migrating-dashboards-to-files.md`.
