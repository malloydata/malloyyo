# Charts (`# bar_chart`, `# line_chart`, …)

The renderer's built-in chart tags cover most dashboard tiles. Tag a nested view
and it draws:

```malloy
nest:
  # bar_chart
  sales_by_brand
  # line_chart
  sales_by_month
```

Related: `yo_help dashboards/grid-layout` (where tiles sit),
`dashboards/vega-charts` (`<VegaChart>`, for shapes these tags can't express),
`dashboards/authoring` (the dashboard file itself).

## Channels: name them, don't leave them to be guessed

A chart has three channels — **x** (the category axis), **y** (the value), and
**series** (the colour split). Set them on the tag:

```malloy
# bar_chart { x=weekday y=drunk }
# bar_chart { x=nickname y=flight_count series=destination }
# line_chart { x=sale_date y=['sales', 'cost'] }
```

Left unset, the renderer infers them: x prefers a time dimension and otherwise
takes the first dimension, y takes the first aggregate, and **series takes any
dimension left over**. That last rule is the one that surprises people — see
below. Naming `x` and `y` explicitly costs one line and removes the guesswork.

Other properties: `.stack`, `.size` (`spark`/`xs`/`sm`/`md`/`lg`/`xl`/`2xl`, or
`size.width` / `size.height`), `.x.limit`, `.series.limit`, and `.independent`
on any channel for nested charts.

## THE RULE: charts count DIMENSIONS, not columns

A chart can carry **one x dimension and one series dimension**. The renderer
counts the *dimensions* in the result (`group_by` fields — not aggregates) and:

- **two dimensions, only `x` named** → the spare one is promoted to a colour
  series, whether or not you wanted a legend
- **three or more dimensions, none tagged `series`** → it refuses:
  *"Too many dimensions. A bar chart can have at most 2 dimensions: 1 for the x
  axis, and 1 for the series. To use 3+ dimensions, explicitly tag multiple
  fields as series."*

That last sentence is the escape hatch: 3+ dimensions is legal if you say which
ones are the series. What is NOT legal is leaving it to be inferred. If you
genuinely want a third dimension in the picture, name it; if you don't, the
problem is that a field you didn't think of as a dimension is one.

Aggregates are exempt. A result can carry as many measures as you like — only
the ones named in `y` (or the first, if `y` is unset) get plotted, and the rest
are ignored rather than turned into channels.

**`# hidden` does not exempt a dimension from this count.** It hides a field in
tables, `big_value` comparisons and `# link` targets; it has no effect on chart
channel assignment. A `# hidden` group_by is still a dimension and will still
become a series.

## Sorting a named axis (the common case this rule makes hard)

You want an axis labelled `Sunday … Saturday`, or `Jan … Dec`, in *that* order —
not alphabetical. The label has to be a string, but the sort key is a number, and
the naive fixes both fail:

```malloy
// WRONG — two dimensions: weekday_num becomes a colour series.
group_by:
  # hidden
  weekday_num is day_of_week(exit_date)
  weekday is pick 'Sunday' when day_of_week(exit_date) = 1 …
```

```malloy
// ALSO WRONG — a `select:` stage is a projection, so it has no measures:
// every column becomes a dimension and a 3-column result is rejected.
} -> {
  select: weekday is pick 'Sunday' when weekday_num = 1 … , drunk, avg_price
}
```

**Make the sort key a MEASURE.** Measures aren't dimensions, so a sort key
expressed as one can never be promoted to a channel:

```malloy
# bar_chart { x=weekday y=drunk }
view: by_weekday is {
  group_by: weekday is
    pick 'Sunday' when day_of_week(exit_date) = 1
    pick 'Monday' when day_of_week(exit_date) = 2
    …
    else 'Saturday'
  aggregate:
    drunk
    weekday_sort is min(day_of_week(exit_date))   // orders rows; never a channel
  order_by: weekday_sort asc
}
```

One dimension reaches the chart, the rows arrive in the order you asked for, and
a bar chart preserves query row order for a categorical axis. The same shape
works for months (`min(month(date))`), fiscal periods, size buckets, and any
other "display a name, sort by a number" axis.

> `min()` because a sort key needs *some* aggregate function and every row in the
> group shares the value; `max()` is equally fine.

## Deciding which tile is a chart at all

- **Ranked categories** (top brands, regions by volume) — `# bar_chart`, ordered
  by the measure. Query order is the bar order.
- **A value over time** — `# line_chart` with the time dimension as `x`.
- **A wide detail table** — no chart tag. Charting eight columns is worse than
  showing them; give the tile `# colspan=6` instead and label the columns.
- **Flat data** — if every bar is within a few percent of the others, the chart
  is saying "no pattern here" at the cost of a card. Consider whether the tile
  earns its place.

## Trends by period: drop the incomplete one

A by-year or by-month trend whose final period is partial draws a cliff that
reads as collapse. Filter to complete periods, using a cutoff that comes from
the DATA (e.g. a snapshot/max-date column carried on a joined dimension), not
from the result set — deriving it from the visible rows will wrongly declare a
period partial as soon as a filter narrows the data.

## Validate

`malloyyo lint` compiles each dashboard and its tiles, but it does not render
them — a chart that compiles can still throw "Too many dimensions" in the
browser. See it with `malloyyo dashboard dev`, which runs the queries
server-side and renders the real result.
