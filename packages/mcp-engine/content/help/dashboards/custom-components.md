---
description: Custom dashboard UI — a ./dashboards/<slug>/Dashboard.tsx composing @malloyyo/dashboard widgets/hooks/helpers with your own React
---

# Custom dashboard components (`Dashboard.tsx`)

The default UI (auto-rendered controls + panel) covers most dashboards. When
it isn't enough, add ONE file — `./dashboards/<slug>/Dashboard.tsx` — that
composes the runtime's widgets/hooks with your own React. You own layout, copy,
and theming; the model still owns every query and filter. See also `yo_help
dashboards/authoring` and `dashboards/vega-charts`.

```tsx
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
          options={[10, 200, 1000].map(n => ({ value: filters.greaterThan(n), text: `> ${n}` }))} />
      </Controls>
      <Panel givens={givens} />         {/* the tagged query, Malloy renderer */}
      <Panel malloy="baby_names -> births_by_decade" givens={givens} />  {/* restricted text */}
    </div>
  );
}
```

From `@malloyyo/dashboard` (also handed to the component as props):
- **Widgets** (headless-ish; restyle via className/style or CSS vars
  `--dash-fg/-muted/-border/-accent/-control-bg/-controls-bg`):
  `<Controls/>` (all givens, or compose children), `<Given name/>`,
  `<Select given [options]/>`, `<Search given/>`, `<Range given [min max]/>`,
  `<TimeRange given [presets]/>` (temporal presets + custom range),
  `<Checkbox given/>` (bound to a boolean given),
  `<VegaChart spec query|malloy|data givens/>` (a Vega-Lite chart over query
  rows — see `yo_help dashboards/vega-charts`)
- **Hooks**: `useGiven(name)` → {value, set, spec};
  `useOptions(name, typed?)` → {options, loading} (typeahead);
  `useQuery({query|malloy, givens})` → {rows, loading, error} — plain rows
  for your own visuals
- **Helpers**: `filters.oneOf/contains/between/atLeast/…` build
  filter-expression strings with correct escaping; temporal:
  `filters.lastN(7, "day")` → `'7 days'`, `filters.dateRange("2026-01-01",
  "2026-07-01")`, `filters.afterDate/beforeDate`; read back with
  `filters.values/numberRange/threshold/inLast/temporalRange`;
  `filters.isValid(type, src)` checks typed input.
  Never hand-concatenate a filter string.
  **Escaping rule for custom controls:** a filter given's value is an
  EXPRESSION, so committing a raw column value is wrong the moment it contains
  a comma/percent/dash ('Tesla, Inc.' parses as two alternatives and matches
  nothing). Commit `filters.oneOf(value)` (exact) or
  `filters.contains(term)` (substring), and unwrap for display with
  `filters.values(src)`. The stock `<Select/>` does this automatically;
  `<Search/>` deliberately commits raw text (its input IS a filter
  expression).
- `<Panel/>` and `runData(text, givens)` — named queries are the primary
  form; arbitrary Malloy runs as a RESTRICTED query (no import / given: /
  connection.* / raw SQL / ##! flags — the model's published surface only).

For charts beyond the Malloy renderer's `#` tags, use `<VegaChart>` —
`yo_help dashboards/vega-charts`.
