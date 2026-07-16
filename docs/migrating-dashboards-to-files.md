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
- **The given mapping is visible** — the dashboard's query, *including its
  `where: … ~ $GIVEN` filtering*, lives in the dashboard file, so a reader sees
  exactly which controls it uses and what they filter, in one place.
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

## Step 2 — Keep the model reusable; put `# drill` on the source

Your source file defines the data shapes, the reusable measures/views, and the
drill links. Keep it **reusable and mostly given-free** — the model describes
*what can be computed*, and each dashboard decides *how it's filtered* (Step 4).

> **The rule of thumb:** the given application — `where: something ~ $GIVEN` —
> belongs in the **dashboard file**, not the model. If you find a
> `where: … ~ $GIVEN` in `baby_names.malloy`, that filtering probably wants to
> move into the dashboard that needs it, so the given mapping is visible in one
> place. (A given that's *intrinsic* to a view can stay — but reach for the
> dashboard first.)

Drill tags live on the **dimension** they drill from, and name the **dashboard**
to open (its file basename):

```malloy
// baby_names.malloy
##! experimental.givens
import "givens.malloy"

source: baby_names is baby_names_base extend {
  # drill { to=name-explorer }        // clicking a name opens dashboards/name-explorer.malloy
  dimension: name is `name`

  measure: total_babies is `number`.sum()
  measure: name_per_100k is …

  // reusable building blocks — NO `where: … ~ $GIVEN` here; the dashboard filters
  view: by_state is { group_by: state; aggregate: name_per_100k }
  view: by_year is { group_by: birth_year; aggregate: total_babies }
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

A dashboard file imports what it needs (the source(s) and, with a bare import,
the givens), then declares its dashboard. There are two forms.

### Preferred — the query lives in the dashboard file (inline `# artifact`)

Define the query **right in the dashboard file** and tag it `# artifact`. This is
the preferred style because **the given mapping is visible in one place** — the
`where: … ~ $GIVEN` that maps each control to what it filters is right here, next
to the dashboard it belongs to. The query IS the dashboard (a single tile); its
own render tags (`# dashboard {columns=…}`, `# bar_chart`, …) govern the layout.

```malloy
// dashboards/name-explorer.malloy
##! experimental.givens
import "../baby_names.malloy"   // bare import: source + givens both in scope

# dashboard { columns=6 } artifact { title="Name explorer" }
query: name_explorer is baby_names -> {
  where: state ~ $STATE and birth_year ~ $YEAR_RANGE   // ← the given mapping, in the dashboard
  group_by: state
  aggregate: name_per_100k
  nest: over_time is by_year
}
```

> **You know you're doing it right when the `where: foo ~ $FOO` is in the
> dashboard file, not the model.** That's the whole point — a reader opens the
> dashboard and sees exactly which givens it uses and how.

### Alternative — reference existing model views (`## artifact { tiles }`)

When you want to compose **several** existing views — especially across
different sources — declare a model-level `## artifact` and name the tiles. Use
this for multi-tile / cross-source dashboards. **The whole `## artifact { … }`
must be on a single line.**

```malloy
// dashboards/overview.malloy
##! experimental.givens
import { baby_names } from "../baby_names.malloy"
import { births } from "../births.malloy"
import "../givens.malloy"

## artifact { title="Overview" tiles=["baby_names -> by_state", "births -> by_year"] dashboard_columns=6 }
```

Tiles use the `source -> view` form. With this form the filtering lives in the
referenced views (or you apply givens by referencing views that already do) — so
prefer the inline form above whenever a dashboard has its own filtering.

### Per-dashboard starting values

Either form can set the controls' starting values with a `givens` block:

```malloy
# artifact { title="…" givens { STATE=f'CA' YEAR_RANGE=f'[2000 to 2020]' } }
// or, on the composite form:
## artifact { title="…" tiles=[…] givens { STATE=f'CA' } }
```

### Optional: a custom component

If a dashboard needs a hand-built layout, add `dashboards/<name>.jsx` next to its
`.malloy`. It imports the dashboard runtime and places `<Panel>`s itself — a
`<Panel query=…/>` runs the inline query (by name) or any `source -> view`:

```jsx
// dashboards/name-explorer.jsx
import { Panel, Controls } from "@malloyyo/dashboard";

export default function Dashboard() {
  return (
    <>
      <Controls />
      <Panel query="name_explorer" />          {/* the inline query in this file */}
      <Panel query="baby_names -> by_year" />   {/* or a model view */}
    </>
  );
}
```

Without a `.jsx`, the dashboard renders automatically.

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
- [ ] The **given application (`where: … ~ $GIVEN`) lives in the dashboard
      files**, not the model — the model views are reusable and given-free.
- [ ] Each dashboard is one `dashboards/<name>.malloy`; prefer the **inline
      `query: … # artifact`** form (fall back to `## artifact { tiles }` only to
      compose existing/cross-source views).
- [ ] Dashboards `import` the source(s) they use; a **bare `import "…/givens.malloy"`**
      (directly, or via a bare import of the model) puts the controls in scope.
- [ ] `# drill { to=<slug> }` tags name real dashboard file basenames.
- [ ] `index.malloy` exports your sources only — no dashboards.
- [ ] Custom components in `dashboards/<name>.jsx` (optional).
- [ ] `malloyyo lint` is clean; `malloyyo dashboard dev` renders each dashboard.

## Common gotchas

- **A control isn't showing.** The dashboard file must have the given
  *declaration* in scope — a **bare** `import "…/givens.malloy"` (or a bare
  import of a model file that imports it). A selective `import { source } from …`
  brings the filter but not the control.
- **`## artifact` didn't take.** It must be on one line, and in the dashboard
  file itself (model annotations don't cross imports). (An inline
  `query: … # artifact` uses the single `#` and has neither caveat.)
- **A drill goes nowhere.** The `to=` slug must match a `dashboards/*.malloy`
  basename exactly; Malloy won't error on a typo, but `lint` will.
- **Reserved words.** Some names (`year`, …) are reserved — quote them
  (`` `year` ``) or rename the given.
