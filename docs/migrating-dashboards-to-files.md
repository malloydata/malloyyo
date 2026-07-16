# Converting a model to dashboard files

This guide walks through restructuring a Malloy model so that **each dashboard
lives in its own file** under `dashboards/`, instead of being declared inside
your model. It uses the **babynames** model as a worked example, but the pattern
is the same for any model.

## Why

A dashboard is now a **self-contained Malloy file** that is compiled on its own.
It imports the parts of your model it needs and declares its own dashboard. This
means:

- **`index.malloy` stays clean** — it's just the semantic surface your MCP/data
  tools talk to. Dashboards don't have to be declared or re-exported there.
- **Any number of dashboards, across any sources** — one file per dashboard.
- **Fewer footguns** — a dashboard that references something it didn't import
  fails loudly, in that file, at that line, instead of silently rendering a
  missing control.

Requires **`@malloydata/malloy` 0.0.423 or newer** (earlier versions drop
annotations — including `# drill` — on refined nests).

## The target layout

```
babynames/
  malloy-config.json
  givens.malloy          # the "knobs": given: declarations + their control tags
  baby_names.malloy      # your source(s), views, measures, and # drill tags
  index.malloy           # import/export your sources — the MCP/data surface
  dashboards/
    over-represented.malloy
    name-explorer.malloy
    name-explorer.jsx     # optional: a custom component for this one dashboard
    name-trend.malloy
```

Each `dashboards/<name>.malloy` is one dashboard; its name is the file's
basename (override with `name=` in the tag). A sibling `<name>.jsx` is an
optional custom component — omit it and the dashboard renders with the built-in
layout.

## Step 1 — Put your givens in `givens.malloy`

Move every `given:` declaration (with its `# label`, `# control`, `# suggest`
tags) into one file. This is the single home for your dashboard controls.

```malloy
// givens.malloy
##! experimental.givens

given:
  # label="State" control=select suggest { source=baby_names dimension=state }
  STATE :: filter<string> is f'NY'
  # label="Years"
  YEAR_RANGE :: filter<number> is f'[1910 to 1930]'
  # label="Min sample"
  MIN_SAMPLE :: filter<number> is f'> 200'
  # label="Name"
  NAME :: filter<string> is f'Emma'
```

Everything that references a given — a source's views, and every dashboard —
brings these into scope with a **bare whole-file import**:

```malloy
import "givens.malloy"       // NOT  import { STATE, … } from "givens.malloy"
```

The bare import pulls in *all* the declarations. Each dashboard automatically
shows a control for exactly the givens its tiles use — you never enumerate them.

## Step 2 — Keep the model simple; put `# drill` on the source

Your source file defines the data shapes and the drill links. Drill tags live on
the **dimension** they drill from, and name the **dashboard** to open (its file
basename):

```malloy
// baby_names.malloy
##! experimental.givens
import "givens.malloy"

source: baby_names is baby_names_base extend {
  # drill { to=name-explorer }        // clicking a name opens dashboards/name-explorer.malloy
  dimension: name is `name`

  view: births_by_year is { group_by: birth_year; aggregate: total_babies }
  view: concentration_by_state is { group_by: state; aggregate: name_per_100k }
  // … the views your dashboards will tile …
}
```

## Step 3 — `index.malloy` is just the data surface

It imports and exports your sources for MCP / your data tools. No dashboards, no
given re-exports.

```malloy
// index.malloy
import { baby_names } from "baby_names.malloy"
export { baby_names }
```

## Step 4 — Write each dashboard as a file

A dashboard file imports the source(s) it tiles and the givens, then declares
one `## artifact` naming its tiles. **The whole `## artifact { … }` must be on a
single line.**

```malloy
// dashboards/name-explorer.malloy
##! experimental.givens
import { baby_names } from "../baby_names.malloy"
import "../givens.malloy"

## artifact { title="Name explorer" tiles=["baby_names -> concentration_by_state", "baby_names -> births_by_year"] dashboard_columns=6 }
```

Tile references use the `source -> view` form. A single-view dashboard is just
`tiles=["baby_names -> name_dashboard"]`. Set per-dashboard starting values for
the controls with a `givens` block:

```malloy
## artifact { title="…" tiles=[…] givens { STATE=f'CA' YEAR_RANGE=f'[2000 to 2020]' } }
```

### Optional: a custom component

If a dashboard needs a hand-built layout, add `dashboards/<name>.jsx` next to its
`.malloy`. It imports the dashboard runtime and places `<Panel>`s itself:

```jsx
// dashboards/name-explorer.jsx
import { Panel, Controls } from "@malloyyo/dashboard";

export default function Dashboard() {
  return (
    <>
      <Controls />
      <Panel query="baby_names -> concentration_by_state" />
      <Panel query="baby_names -> births_by_year" />
    </>
  );
}
```

Without a `.jsx`, the dashboard renders automatically from its `tiles`.

## Step 5 — Check it

```bash
malloyyo lint          # each dashboard file compiles; tiles run; drill targets resolve
malloyyo dashboard dev # preview them in the browser
```

`lint` now checks each dashboard file on its own: it compiles, its tiles run,
its `# suggest`s compile, `dashboard_columns` is valid, and every `# drill`
target points at a real dashboard file.

## Conversion checklist

- [ ] `givens.malloy` holds every `given:` + its control tags.
- [ ] Sources and dashboards each `import "…/givens.malloy"` (bare).
- [ ] `# drill { to=<slug> }` tags name real dashboard file basenames.
- [ ] `index.malloy` exports your sources only — no dashboards.
- [ ] One `dashboards/<name>.malloy` per dashboard; `## artifact { … }` on one line.
- [ ] Custom components moved to `dashboards/<name>.jsx` (optional).
- [ ] `malloyyo lint` is clean; `malloyyo dashboard dev` renders each dashboard.

## Common gotchas

- **A control isn't showing.** The dashboard file must `import "…/givens.malloy"`
  (bare). Importing only the source brings the *filter* but not the control.
- **`## artifact` didn't take.** It must be on one line, and in the dashboard
  file itself (model annotations don't cross imports).
- **A drill goes nowhere.** The `to=` slug must match a `dashboards/*.malloy`
  basename exactly; Malloy won't error on a typo, but `lint` will.
- **Reserved words.** Some names (`year`, …) are reserved — quote them
  (`` `year` ``) or rename the given.
