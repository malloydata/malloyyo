---
description: Custom dashboard UI — a flat dashboards/<name>.jsx|tsx sibling composing @malloyyo/dashboard widgets/hooks/helpers with your own React
---

# Custom dashboard components (`dashboards/<name>.jsx`)

The default UI (auto-rendered controls + panel) covers most dashboards. When it
isn't enough, add ONE file — a **flat sibling** `dashboards/<name>.jsx` (or
`.tsx`) next to the dashboard's `dashboards/<name>.malloy` (same basename) — that
composes the runtime's widgets/hooks with your own React. You own layout, copy,
and theming; the `.malloy` file still owns every query and filter. See also
`yo_help dashboards/authoring` and `dashboards/vega-charts`.

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
      <Panel givens={givens} />         {/* the dashboard itself (its tiles/query) */}
      <Panel query="baby_names -> births_by_decade" givens={givens} />  {/* a specific query */}
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
  for your own visuals;
  `useUrlState(key, initial)` → [value, setValue] — shareable view-state (below)
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
- `<Panel/>` runs against the DASHBOARD's own file: a bare `<Panel/>` renders
  the whole dashboard (its tiles); `<Panel query="…"/>` runs a query defined in
  the dashboard file (by name) or a `source -> view`; `<Panel malloy="…"/>` and
  `runData(text, givens)` run arbitrary Malloy as a RESTRICTED query (no import /
  given: / connection.* / raw SQL / ##! flags — the model's governed surface
  only). `lint` checks each hard-coded `query="…"` still resolves.

## Shareable view-state: `useUrlState`

`useState` is invisible to the page that owns the URL, so a component built on
it has an address bar that never changes — the result can't be shared or
bookmarked. **`useUrlState(key, initial)` is a `useState` twin whose value lives
in the URL**, under a `~key` param:

```jsx
import { useUrlState } from "@malloyyo/dashboard";

const [rack,  setRack]  = useUrlState("rack", "");          // string
const [reuse, setReuse] = useUrlState("reuse", false);      // boolean
const [board, setBoard] = useUrlState("board", "........"); // string
const [topN,  setTopN]  = useUrlState("n", 20);             // number
```

- Same shape as `useState`: `[value, setValue]`, and `setValue` takes a value
  **or** an updater fn (`setBoard(b => …)`).
- The value comes from the URL on load, else `initial`. Every change is written
  back (debounced, `replaceState` — no history spam), so the address bar is
  always a shareable link.
- Typed by `initial`: string / number / boolean / any JSON-serializable value.
  Strings stay readable in the URL (`~rack=retinas`); objects and arrays are
  JSON. A value equal to `initial` is dropped from the URL, so defaults never
  clutter it, and a malformed value falls back to `initial` instead of throwing.
- Works identically in `malloyyo dashboard dev`, on a bundled static site, and
  on a hosted instance — including inside the sandboxed iframe, which cannot
  reach the top-level URL on its own. That's why this is a hook and not
  something a component can do with `history.replaceState`.

**Use it for view-state, not query parameters.** A `given:` is the governed,
filter-typed query contract: it's declared in the model, drives the default
controls, and is visible over MCP — bind those with `useGiven` and they already
round-trip through the URL as `$NAME`. `useUrlState` is for everything else a
custom component needs to make shareable: a letter rack whose real query inputs
(allowed letters, min/max length) are computed from it in JS, a board layout, a
mode toggle. The two namespaces (`$NAME` vs `~key`) never collide.

## Theming

Every widget is styled by the runtime's **default Malloyyo theme** (system
font, neutral grays, blue accent, auto light/dark following the viewer's OS) —
a bare component looks styled with zero effort, so DON'T hand-hardcode
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

**Use `--dash-*` and nothing else.** A custom component renders in its own
**iframe**, so CSS variables defined by the surrounding page — including the
bundled site's `--line` / `--card` / `--muted` — are NOT in scope inside it. A
component styled against those still renders, but every rule referencing them
resolves to nothing: borders, dividers and panel backgrounds vanish silently
while text and layout survive, so the page looks *almost* right and the cause
isn't obvious. If you're porting CSS that has to work both inside the frame and
on a bundled page, resolve each colour once through the chain and use the alias:

```css
.my-card {
  --edge: var(--dash-border, var(--line, #e4e6eb));
  --surface: var(--dash-panel-bg, var(--card, #fff));
  border: 1px solid var(--edge);
  background: var(--surface);
}
```

This is a class of bug `lint` cannot see and a screenshot can — look at custom
components in `malloyyo dashboard dev` before shipping them.

For charts beyond the Malloy renderer's `#` tags, use `<VegaChart>` —
`yo_help dashboards/vega-charts`.
