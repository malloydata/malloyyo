// Authoring directions surfaced to an MCP client (Claude Code) via the local
// `malloyyo mcp` server instructions. Tells the agent how to build a dashboard
// artifact for the model it's exploring.
//
// Prototype note: this is appended host-side to the explore surface's rendered
// instructions. The eventual home is the engine content pipeline
// (content/prompts/**), but shipping it here keeps the loop testable now.

export const DASHBOARD_GUIDANCE = `

# Authoring dashboards

A dashboard is DECLARED IN THE MODEL — there is no manifest file and, for the
basic case, no JavaScript at all. Preview with \`malloyyo dashboard dev\`; check
with \`malloyyo lint\`.

> **Need a chart the \`# bar_chart\`/\`# line_chart\`/\`# shape_map\` renderer tags
> can't do?** Use the \`<VegaChart>\` COMPONENT (a Vega-Lite spec over query
> rows) in a custom \`Dashboard.tsx\` — NOT a \`#\` tag; there is no
> \`# vega_lite\`. See "Custom charts with Vega-Lite" below, or
> \`yo_help dashboards/vega-charts\`.

## Make dashboards discoverable: the entry model

**The entry is \`index.malloy\`.** \`dashboard dev\`, \`lint\`, and the hosted
server only see what that file EXPORTS. Three things must all be surfaced
(imported AND exported) through it, or the feature looks broken:

1. **Whatever holds each \`# artifact\` tag.** A tag on a \`view:\` rides along
   with its SOURCE (export the source — you can't export a view on its own); a
   tag on a top-level \`query:\` needs that query exported. Not surfaced →
   \`dashboard dev\` says "No dashboards declared" and \`lint\` says "no dashboards
   to lint", even though the model compiles clean.
2. **Every filter given the dashboards reference.** An unexported given
   silently resolves to its declaration default — the control still renders
   but CAN'T CHANGE THE QUERY (the filter looks inert).
3. **Whatever backs each \`suggest\`** — the named query (\`suggest {query=…}\`)
   or source (\`suggest {source=…}\`). Suggestions run against the entry model;
   an unexported one fails lint with "Reference to undefined object".

\`\`\`malloy
##! experimental.givens
import {
  order_items,                      // the source — carries its # artifact views
  BRAND, CATEGORY, PERIOD,          // the filter givens
  brand_suggest                     // backs a suggest {query=…}
} from 'ecommerce.malloy'
export { order_items, BRAND, CATEGORY, PERIOD, brand_suggest }
\`\`\`

Exporting the source is often the whole job: its \`# artifact\` views, its
dimensions (for \`suggest {source=…}\`), and its measures all travel with it.

Prefer \`suggest { query=<named-query> … }\` over \`suggest { source=… }\` for
anything beyond a throwaway: you export one small governed query instead of a
whole base source.

## The model is the whole contract

**1. Tag a \`view:\` inside a source** with \`# artifact\` to declare a dashboard
(the idiomatic form — a view is reusable, nestable, and explorable through the
normal \`query\`/\`describe_source\` surface). For the common overview shape
(top-level aggregates + nests), ALSO tag it \`# dashboard\` so the result
renders as KPI tiles + a card grid instead of one flat table — they're
partners: \`# artifact\` declares the dashboard, \`# dashboard\` is the renderer
tag that draws it like one:

\`\`\`malloy
source: order_items is … extend {
  #" Business health at a glance — sales, margin, orders.
  # artifact { title="Business Overview" } dashboard
  view: overview_dashboard is {
    where:
      inventory_items.product_brand ~ $BRAND,     // multi-filter where: is
      inventory_items.product_category ~ $CATEGORY,  // COMMA separated
      created_at ~ $PERIOD
    aggregate: total_sales, total_gross_margin, order_count
    nest:
      # line_chart
      sales_trend is by_month
      top_brands
      # shape_map
      sales_by_state
  }
}
\`\`\`

That's a complete dashboard: the runtime auto-renders a title (the tag's
\`title\`, else the \`#"\` doc comment), a control for every given the view
references, and the result panel. It runs as \`run: <source> -> <view>\` (here
\`order_items -> overview_dashboard\`). \`name="slug"\` overrides the
URL/directory slug (default: the view name). Note the \`where:\` clauses
applying givens are COMMA-separated — newline-separated conditions do not
parse.

Tagging a **top-level \`query:\`** still works and behaves identically (it runs
as \`run: <name>\`) — reach for it only when the dashboard query doesn't belong
to any one source.

**Deep-link a cell** to an external system — tag any \`group_by:\`/\`select:\`
field \`# link\` (the value is a full URL) or
\`# link { url_template="https://…/$$" }\` (\`$$\` = the cell value; add
\`field=id\` to link on a separate, usually \`# hidden\`, id column). Common in a
nested detail table so each row jumps to its record. \`# image { url_template=… }\`
renders a cell as an inline image. Links open in a new browser tab.

Two dashboards can share a given but start on different values — a \`givens\`
block in the tag sets PER-DASHBOARD defaults (given values, i.e. filter
expressions; URL params still win):

\`\`\`malloy
# artifact { name="manufacturer" title="Manufacturer Recall Profile" givens { MANUFACTURER="Ford Motor Company" } }
\`\`\`

This replaces the "declare the given's default per dashboard" role the old
manifests had: declare the given once with a neutral default (often \`f''\` =
no filter), and let each tag pick its landing state.

**2. Declare the filters as \`filter<T>\` givens** — never raw strings/numbers.
A \`filter<string>\` value accepts one value ('NY'), alternatives ('NY, CA'),
wildcards ('Ann%'), negation ('-NY'); a \`filter<number>\` accepts ranges
('[1910 to 1930]') and comparisons ('> 200'); a \`filter<timestamp>\` /
\`filter<date>\` accepts relative windows ('7 days' = the last 7 days, 'today',
'last month') and literal ranges ('2026-01-01 to 2026-07-01' — NO \`@\` in
filter literals). Apply with \`~\`; \`f''\` = empty = no filter (the natural
"All"/"all time" — just \`col ~ $X\`, no \`$X = '' or …\` dance):

\`\`\`malloy
##! experimental { givens }
given:
  # label="State" control=select suggest { source=baby_names dimension=state }
  STATE :: filter<string> is f'NY'
  # label="Brand" suggest { query=brand_suggest dimension=product_brand }
  BRAND :: filter<string> is f''
  # label="Years" range_min=1910 range_max=2025
  YEAR_RANGE :: filter<number> is f'[1910 to 1930]'
  # label="Time period"
  PERIOD :: filter<timestamp> is f''
  # label="Include rare names"
  INCLUDE_RARE :: boolean is false
\`\`\`

Tags on the declaration drive the control (tag syntax is \`key="value"\` —
equals, not colon):
- \`label\` — control caption (defaults to the given's name)
- \`suggest { … }\` — where the control's options come from. NO Malloy code in
  strings — just names:
  - \`suggest { query=brand_suggest dimension=product_brand }\` — the FIRST
    COLUMN of a named query (declare the query in the model — governed,
    reviewable, and only that query needs exporting). PREFER THIS FORM.
  - \`suggest { source=baby_names dimension=state }\` — the DISTINCT VALUES of
    a dimension on a source (the whole source must be exported)
  A \`dimension\` (in either form) is what enables SERVER-SIDE TYPEAHEAD: the
  runtime refines the base query with what the user has typed
  (\`… + { where: lower(field) ~ f'll%'; limit: 50 }\`, case-insensitive,
  escaped). Without a dimension the fetched list is filtered client-side.
  Runs as a restricted query; lint checks the declaration compiles.

  **RELATED (faceted) filters** — query-form only: a suggest query may
  reference the OTHER givens, and the runtime runs it with the dashboard's
  current values (the suggested given itself is excluded, so the list never
  collapses to the current pick). Brand suggestions narrow when Category is
  set:

  \`\`\`malloy
  query: brand_suggest is inventory_items -> product_brand + {
    where:
      product_category ~ $CATEGORY,      // NOT product_brand ~ $BRAND
      product_department ~ $DEPARTMENT
    limit: 500
  }
  \`\`\`

  Declare one \`*_suggest\` per filter, each referencing the others; \`f''\`
  defaults mean unset filters don't constrain. \`source=\` suggests can't do
  this (no place for a \`where:\`) — another reason to prefer \`query=\`.
- \`control=select\` — a fixed dropdown instead of a typeahead search box
- \`range_min\` / \`range_max\` — bounds; makes a filter<number> given a
  dual-thumb range slider
- anything else passes through in \`spec.tags\` for custom components

Control picked from the declaration automatically: numeric range tags →
dual-thumb slider; \`filter<timestamp|timestamptz|date>\` → the TimeRange
widget (relative presets: Today / Last 7 days / Last 30 days / … plus a
"Custom range…" from/to date picker); suggest + control=select → dropdown;
boolean → checkbox; anything else → committing search box with typeahead.
The suggest-driven options are DATA VALUES only — options that aren't column
values (custom time presets, threshold buckets) need a custom component
(below) with explicit \`{value, text}\` options where value is a filter
expression built with \`filters.*\`.

## Custom components (optional): ./dashboards/<slug>/Dashboard.tsx

When the default UI isn't enough, add ONE file. It composes the runtime's
widgets/hooks with your own React — you own layout, copy, and theming; the
model still owns every query and filter:

\`\`\`tsx
import React from "react";
import { Controls, Given, Search, Select, TimeRange, Panel, filters, useGiven } from "@malloyyo/dashboard";

export default function Dashboard({ dashboard, givens }) {
  return (
    <div style={{ maxWidth: 860, margin: "0 auto", padding: 24 }}>
      <h1>{dashboard.title}</h1>
      <Controls>
        <Given name="STATE" />          {/* picks the control from the declaration */}
        <Search given="NAME" />         {/* committing input + typeahead + validation */}
        <TimeRange given="PERIOD" presets={[
          { value: "", text: "All time" },
          { value: filters.lastN(1, "day"), text: "Last day" },
          { value: filters.lastN(1, "week"), text: "Last week" },
          { value: filters.lastN(1, "month"), text: "Last month" },
        ]} />                            {/* "Custom range…" is always appended */}
        <Select given="MIN_SAMPLE"
          options={[10, 200, 1000].map(n => ({ value: filters.greaterThan(n), text: \`> \${n}\` }))} />
      </Controls>
      <Panel givens={givens} />         {/* the tagged query, Malloy renderer */}
      <Panel malloy="baby_names -> births_by_decade" givens={givens} />  {/* restricted text */}
    </div>
  );
}
\`\`\`

From \`@malloyyo/dashboard\` (also handed to the component as props):
- **Widgets** (headless-ish; restyle via className/style or CSS vars
  \`--dash-fg/-muted/-border/-accent/-control-bg/-controls-bg\`):
  \`<Controls/>\` (all givens, or compose children), \`<Given name/>\`,
  \`<Select given [options]/>\`, \`<Search given/>\`, \`<Range given [min max]/>\`,
  \`<TimeRange given [presets]/>\` (temporal presets + custom range),
  \`<Checkbox given/>\` (bound to a boolean given),
  \`<VegaChart spec query|malloy|data givens/>\` (a Vega-Lite chart over query
  rows — see "Custom charts" below)
- **Hooks**: \`useGiven(name)\` → {value, set, spec};
  \`useOptions(name, typed?)\` → {options, loading} (typeahead);
  \`useQuery({query|malloy, givens})\` → {rows, loading, error} — plain rows
  for your own visuals
- **Helpers**: \`filters.oneOf/contains/between/atLeast/…\` build
  filter-expression strings with correct escaping; temporal:
  \`filters.lastN(7, "day")\` → \`'7 days'\`, \`filters.dateRange("2026-01-01",
  "2026-07-01")\`, \`filters.afterDate/beforeDate\`; read back with
  \`filters.values/numberRange/threshold/inLast/temporalRange\`;
  \`filters.isValid(type, src)\` checks typed input.
  Never hand-concatenate a filter string.
  **Escaping rule for custom controls:** a filter given's value is an
  EXPRESSION, so committing a raw column value is wrong the moment it contains
  a comma/percent/dash ('Tesla, Inc.' parses as two alternatives and matches
  nothing). Commit \`filters.oneOf(value)\` (exact) or
  \`filters.contains(term)\` (substring), and unwrap for display with
  \`filters.values(src)\`. The stock \`<Select/>\` does this automatically;
  \`<Search/>\` deliberately commits raw text (its input IS a filter
  expression).
- \`<Panel/>\` and \`runData(text, givens)\` — named queries are the primary
  form; arbitrary Malloy runs as a RESTRICTED query (no import / given: /
  connection.* / raw SQL / ##! flags — the model's published surface only).

### Custom charts with Vega-Lite: \`<VegaChart>\`

For a chart the Malloy renderer's tags (\`# bar_chart\`, \`# line_chart\`,
\`# shape_map\` …) don't cover, use \`<VegaChart>\`. It renders a **Vega-Lite
spec** against Malloy query rows — the engine is bundled into the runtime, so a
dashboard ships only the JSON spec + a query (no chart library is loaded).

\`\`\`tsx
import { VegaChart } from "@malloyyo/dashboard";

// The spec's own \`data\` is IGNORED — rows are inlined as the dataset. Point the
// encodings at your query's OUTPUT COLUMN NAMES.
const spec = {
  mark: "bar",
  encoding: {
    x: { field: "state", type: "nominal", sort: "-y" },
    y: { field: "births", type: "quantitative" },
    color: { field: "gender", type: "nominal" },
  },
};

<VegaChart spec={spec} query="births_by_state" givens={givens} />   // a named query
<VegaChart spec={spec} malloy="baby_names -> births_by_state" givens={givens} />  // restricted text
<VegaChart spec={spec} data={rows} />                              // rows you already have (useQuery)
\`\`\`

Rules that keep it working inside the sandbox:
- **Data comes only from Malloy.** Any \`data.url\` / remote loader in the spec is
  STRIPPED — the frame has no network. Adapt a gallery example by DELETING its
  \`"data": {"url": …}\` and pointing encodings at your query's columns; the rows
  are inlined for you. (Geo examples that fetch topojson by URL won't work.)
- **Column names must match** the query output exactly (run it with
  \`query(execute:true)\` to see the columns). Malloy nests come back as arrays —
  flatten to the rows you want to plot with the query itself, or bind a nest to
  its own \`<VegaChart data={row.nest}/>\`.
- One inlined dataset per chart; give the spec a \`width\`/\`height\` or let it
  default to container width. Client-side interactions (tooltips, zoom, brush)
  work; anything that calls a server does not.
- Style via the spec (\`config\`), or wrap in a div. It reads the same
  \`--dash-*\` surface as the rest of the dashboard is up to your \`config\`.

## Rules
- Declare data in the model: givens are \`filter<T>\`, options come from
  \`# suggest {…}\` declarations, dashboards are \`# artifact\` tags. If a query or given you
  need is missing, add it to the \`.malloy\` file first (check with
  \`describe_source\`).
- Surface everything through the entry model (see the top section).
- Only React + \`@malloyyo/dashboard\` are importable. No other imports, no
  network — the runtime sandboxes the component.
- Interactivity = setting given values (filter-expression strings), not
  rewriting query text per interaction.

## Preview & validate
\`malloyyo dashboard dev\` → open the printed URL. Edits to \`.malloy\` (tags,
givens, queries) and \`Dashboard.tsx\` hot-reload. \`malloyyo lint\` validates
the tagged queries, given \`suggest\` declarations, and any Dashboard.tsx —
but only for dashboards REACHABLE FROM THE ENTRY: "no dashboards to lint"
usually means the \`# artifact\` queries aren't exported through
\`index.malloy\`, not that they don't exist.

Validation loop that works well: the local \`malloyyo mcp\` server hot-reloads
working-directory edits — \`query(execute:false)\` to compile-check,
\`execute:true\` to run. A \`# artifact\` view runs as
\`run: <source> -> <view>\`; a top-level \`# artifact\` query runs as
\`run: <name>\`. Either is only visible once surfaced through the entry (export
the source for a view, the query for a top-level query). Don't validate local
edits against a hosted/claude.ai connector — that serves the PUBLISHED model,
which is stale until \`malloyyo publish\`.
`;
