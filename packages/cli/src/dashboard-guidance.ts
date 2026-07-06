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

## Make dashboards discoverable: the entry model

**The entry is \`index.malloy\`.** \`dashboard dev\`, \`lint\`, and the hosted
server only see what that file EXPORTS. Three things must all be surfaced
(imported AND exported) through it, or the feature looks broken:

1. **The \`# artifact\`-tagged queries.** Declared in another file and not
   exported → \`dashboard dev\` says "No dashboards declared" and \`lint\` says
   "no dashboards to lint", even though the model compiles clean.
2. **Every filter given the dashboards reference.** An unexported given
   silently resolves to its declaration default — the control still renders
   but CAN'T CHANGE THE QUERY (the filter looks inert).
3. **Whatever backs each \`suggest\`** — the named query (\`suggest {query=…}\`)
   or source (\`suggest {source=…}\`). Suggestions run against the entry model;
   an unexported one fails lint with "Reference to undefined object".

\`\`\`malloy
##! experimental.givens
import {
  order_items,
  BRAND, CATEGORY, PERIOD,          // the filter givens
  brand_suggest,                    // backs a suggest {query=…}
  overview_dashboard                // the # artifact query
} from 'ecommerce.malloy'
export { order_items, BRAND, CATEGORY, PERIOD, brand_suggest, overview_dashboard }
\`\`\`

Prefer \`suggest { query=<named-query> … }\` over \`suggest { source=… }\` for
anything beyond a throwaway: you export one small governed query instead of a
whole base source.

## The model is the whole contract

**1. Tag a top-level query** with \`# artifact\` to declare a dashboard. For
the common overview shape (top-level aggregates + nests), ALSO tag it
\`# dashboard\` so the result renders as KPI tiles + a card grid instead of one
flat table — they're partners: \`# artifact\` declares the dashboard,
\`# dashboard\` is the renderer tag that draws it like one:

\`\`\`malloy
#" Business health at a glance — sales, margin, orders.
# artifact { title="Business Overview" } dashboard
query: overview_dashboard is order_items -> {
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
\`\`\`

That's a complete dashboard: the runtime auto-renders a title (the tag's
\`title\`, else the \`#"\` doc comment), a control for every given the query
references, and the result panel. \`name="slug"\` overrides the URL/directory
slug (default: the query name). Note the \`where:\` clauses applying givens are
COMMA-separated — newline-separated conditions do not parse.

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
  \`<Checkbox given/>\` (bound to a boolean given)
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
\`execute:true\` to run. A top-level \`# artifact\` query runs as
\`run: <name>\` (not \`source -> <name>\`), and is only visible once exported
through the entry. Don't validate local edits against a hosted/claude.ai
connector — that serves the PUBLISHED model, which is stale until
\`malloyyo publish\`.
`;
