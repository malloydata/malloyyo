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
- **Widgets** (headless-ish; restyle via className/style or the `--dash-*` CSS
  vars — see Theming below): `<Controls/>` (all givens, or compose children;
  grows Apply/Reset under `autorun=false`), `<Given name/>`,
  `<Select given [options]/>`, `<Search given/>` (committing input + typeahead +
  inline ✕ clear), `<MultiSelect given [options]/>` (chip multi-select for a
  `filter<string>` — commits an exact-match list via `filters.oneOf`),
  `<Range given [min max]/>`, `<TimeRange given [presets]/>` (temporal presets +
  custom range), `<Checkbox given/>` (bound to a boolean given),
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

## Theming

Every widget is styled by the runtime's **default Malloyyo theme** (system
font, neutral grays, blue accent, auto light/dark following the viewer's OS) —
a bare `Dashboard.tsx` looks styled with zero effort, so DON'T hand-hardcode
`fontFamily`/colors. The theme is CSS custom properties; override any subset by
setting them on a wrapper element (more specific than the runtime's `:root`):

```tsx
<div style={{ "--dash-accent": "#e11d48", "--dash-controls-bg": "#faf5ff" }}>
  <Controls /> …
</div>
```

Vars: `--dash-font`, `--dash-bg`, `--dash-fg`, `--dash-muted`, `--dash-border`,
`--dash-accent`, `--dash-accent-fg`, `--dash-control-bg`, `--dash-controls-bg`,
`--dash-chip-bg`, `--dash-chip-fg`, `--dash-panel-bg`, `--dash-radius`,
`--dash-danger`. `DefaultDashboard` also takes a `theme={{ accent, controlsBg }}`
prop (camelCase keys → `--dash-*`). The results `<Panel>` keeps a light surface
in both light/dark (the Malloy renderer has no dark theme) — override
`--dash-panel-bg` if your renderer output is dark-safe.

For charts beyond the Malloy renderer's `#` tags, use `<VegaChart>` —
`yo_help dashboards/vega-charts`.
