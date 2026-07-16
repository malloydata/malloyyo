---
description: Custom dashboard charts with Vega-Lite — the <VegaChart> component, for charts the # renderer tags can't do
---

# Custom charts with Vega-Lite (`<VegaChart>`)

When Malloy's renderer tags (`# bar_chart`, `# line_chart`, `# shape_map`, …)
don't cover the chart you want, a dashboard can draw a **Vega-Lite** spec with
the `<VegaChart>` component. The chart engine ships in the dashboard runtime, so
you author only a JSON spec + a Malloy query — no library to load.

**It is a COMPONENT, not a `#` tag.** There is no `# vega_lite` or
`# scatter_chart` tag. `<VegaChart>` lives in a custom component — a flat sibling
`dashboards/<name>.jsx` (or `.tsx`) next to the dashboard's
`dashboards/<name>.malloy` — a different layer from the `#` renderer tags. (The
dashboard's query is declared in the `.malloy` file; the component only
customizes presentation. Preview with `malloyyo dashboard dev`, validate with
`malloyyo lint`.)

## The recipe

```tsx
import { VegaChart } from "@malloyyo/dashboard";

// Encodings point at the query's OUTPUT COLUMN NAMES (here: name, births).
const spec = {
  mark: { type: "bar", tooltip: true },
  encoding: {
    y: { field: "name", type: "nominal", sort: "-x" },
    x: { field: "births", type: "quantitative" },
  },
};

export default function Dashboard({ givens }) {
  return <VegaChart spec={spec} query="births_by_name" givens={givens} />;
}
```

Three ways to feed it data:
- `<VegaChart spec={spec} query="births_by_name" givens={givens}/>` — a query
  defined in the dashboard's `.malloy` file (by name), or a `source -> view`
- `<VegaChart spec={spec} malloy="source -> view" givens={givens}/>` — restricted
  Malloy text (same governance as the explore surface: no import / given: /
  connection.* / raw SQL / ##! flags)
- `<VegaChart spec={spec} data={rows}/>` — rows you already have from `useQuery`

## Gotchas (the ones that actually bite)

- **Shape the data in Malloy; return FLAT rows.** Do ranking, share/percent
  (`all(x, dim)`), and label lookups (a `pick` for month names) in the QUERY.
  The spec just encodes columns — it is not the place to reshape data.
- **Match column names character-for-character.** Run the query once with
  `query(execute:true)` and read the exact output column names; the spec's
  `field` values must match them exactly.
- **The spec's `data` is ignored / any `url` is stripped.** The frame has no
  network — remote data URLs, transform lookups, and remote `image` marks are
  removed. Adapting a Vega-Lite gallery example = delete its
  `"data": {"url": …}` and repoint the encodings; the query rows are inlined for
  you as the dataset.
- **Nests come back as arrays.** Flatten to plottable rows in the query, or bind
  a nest to its own chart: `<VegaChart data={row.my_nest}/>`.
- **Interactivity = setting given values**, never rewriting query text per
  interaction. Client-side chart interactions (tooltip, zoom, brush) work;
  anything that calls a server does not.
- **Reads well:** for normalized/share data use a diverging color scale with
  `domainMid` (e.g. `1/12` for month-share), and sort a discrete axis by a
  companion numeric field (`month_name` sorted by `month_num`) rather than
  alphabetically.

## Validate

`malloyyo lint` checks the query, the givens, AND the component (it compiles,
and each `query="…"` it references resolves) — your only pre-browser check. Then
`malloyyo dashboard dev` to see it render.
