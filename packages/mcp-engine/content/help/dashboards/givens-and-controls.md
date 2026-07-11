---
description: Dashboard filter controls — declare filter<T> givens with # label / suggest / control tags; faceted (related) suggestions
---

# Dashboard givens & controls

A dashboard's filters are `filter<T>` **givens** declared in the model; the
`#` tags on each declaration drive its control. This is part of authoring a
dashboard — see also `yo_help dashboards/authoring`.

**Declare the filters as `filter<T>` givens** — never raw strings/numbers.
A `filter<string>` value accepts one value ('NY'), alternatives ('NY, CA'),
wildcards ('Ann%'), negation ('-NY'); a `filter<number>` accepts ranges
('[1910 to 1930]') and comparisons ('> 200'); a `filter<timestamp>` /
`filter<date>` accepts relative windows ('7 days' = the last 7 days, 'today',
'last month') and literal ranges ('2026-01-01 to 2026-07-01' — NO `@` in
filter literals). Apply with `~`; `f''` = empty = no filter (the natural
"All"/"all time" — just `col ~ $X`, no `$X = '' or …` dance):

```malloy
##! experimental { givens }
given:
  # label="State" control=select suggest { source=baby_names dimension=state }
  STATE :: filter<string> is f'NY'
  # label="Brand" suggest { query=brand_suggest dimension=product_brand }
  BRAND :: filter<string> is f''
  # label="Names" control=multiselect suggest { query=name_suggest dimension=name }
  NAMES :: filter<string> is f''
  # label="Years" range_min=1910 range_max=2025
  YEAR_RANGE :: filter<number> is f'[1910 to 1930]'
  # label="Time period"
  PERIOD :: filter<timestamp> is f''
  # label="Include rare names"
  INCLUDE_RARE :: boolean is false
```

Tags on the declaration drive the control (tag syntax is `key="value"` —
equals, not colon):
- `label` — control caption (defaults to the given's name)
- `suggest { … }` — where the control's options come from. NO Malloy code in
  strings — just names:
  - `suggest { query=brand_suggest dimension=product_brand }` — the FIRST
    COLUMN of a named query (declare the query in the model — governed,
    reviewable, and only that query needs exporting). PREFER THIS FORM.
  - `suggest { source=baby_names dimension=state }` — the DISTINCT VALUES of
    a dimension on a source (the whole source must be exported)
  A `dimension` (in either form) is what enables SERVER-SIDE TYPEAHEAD: the
  runtime refines the base query with what the user has typed
  (`… + { where: lower(field) ~ f'll%'; limit: 50 }`, case-insensitive,
  escaped). Without a dimension the fetched list is filtered client-side.
  Runs as a restricted query; lint checks the declaration compiles.

  **RELATED (faceted) filters** — query-form only: a suggest query may
  reference the OTHER givens, and the runtime runs it with the dashboard's
  current values (the suggested given itself is excluded, so the list never
  collapses to the current pick). Brand suggestions narrow when Category is
  set:

  ```malloy
  query: brand_suggest is inventory_items -> product_brand + {
    where:
      product_category ~ $CATEGORY,      // NOT product_brand ~ $BRAND
      product_department ~ $DEPARTMENT
    limit: 500
  }
  ```

  Declare one `*_suggest` per filter, each referencing the others; `f''`
  defaults mean unset filters don't constrain. `source=` suggests can't do
  this (no place for a `where:`) — another reason to prefer `query=`.
- `control=select` — a fixed dropdown instead of a typeahead search box
- `control=multiselect` — a tokenized multi-select for a `filter<string>`:
  each pick is a removable chip, the committed value is an exact-match list
  (`Emma, Olivia, Sophia`). Ideal for "pick several" filters (names, brands).
  Suggestions come from the given's `suggest {…}` (server-side typeahead when
  it names a dimension). Empty (start from `f''`) = no filter (all).
- `range_min` / `range_max` — bounds; makes a filter<number> given a
  dual-thumb range slider
- anything else passes through in `spec.tags` for custom components

Control picked from the declaration automatically: numeric range tags →
dual-thumb slider; `filter<timestamp|timestamptz|date>` → the TimeRange
widget (relative presets: Today / Last 7 days / Last 30 days / … plus a
"Custom range…" from/to date picker); `control=multiselect` → chip
multi-select; suggest + control=select → dropdown; boolean → checkbox;
anything else → committing search box with typeahead (an inline ✕ clears it;
a "Press ↵ to apply" hint shows while the typed draft differs from what's
running — free text can't safely re-run per keystroke).
The suggest-driven options are DATA VALUES only — options that aren't column
values (custom time presets, threshold buckets) need a custom component
(`yo_help dashboards/custom-components`) with explicit `{value, text}` options
where value is a filter expression built with `filters.*`.

## When the query re-runs: live (default) vs. Apply

By default a dashboard is **live** — every control change re-runs the query
immediately (the committing search box is the exception: free text commits on
Enter/blur, since a half-typed filter is invalid). To batch changes behind an
**Apply** button instead, set `autorun=false` on the `# artifact` tag:

```malloy
# artifact { name="births-by-name" title="Births by name" autorun=false }
```

`autorun=false` makes `<Controls>` grow an Apply/Reset pair — controls edit a
draft and nothing re-runs until Apply. Reach for it when the query is expensive
or several filters are usually changed together; leave it off (live) otherwise.
