---
description: Answer with a chart — the render tags, how channels are chosen, and when a chart beats a table
---

# Charting a result

A query result renders as a table unless you tag it. One line above the query
turns it into a chart, and the tag travels with the result — so a shared link or
a saved query draws the same picture later.

```malloy
# bar_chart
run: order_items -> {
  group_by: brand is inventory_items.product_brand
  aggregate: total_sales
  order_by: total_sales desc
  limit: 10
}
```

**A tag on its own line attaches to the thing on the NEXT line.** That is the
whole placement rule, and it is also the trap:

```malloy
// WRONG — the tag attaches to `birth_year`, not to the query.
// Malloy compiles this, runs it, returns rows, and silently draws a TABLE.
run: baby_names -> {
  where: name = 'James' | 'Michael'
  # line_chart { x=birth_year y=total_babies series=name }
  group_by: birth_year
  group_by: name
  aggregate: total_babies
}
```

```malloy
// RIGHT — above `run:`, so it attaches to the query.
# line_chart { x=birth_year y=total_babies series=name }
run: baby_names -> {
  where: name = 'James' | 'Michael'
  group_by: birth_year
  group_by: name
  aggregate: total_babies
}
```

Nothing warns you. The tag simply does not appear in the result's annotations,
and the renderer has no chart to draw. If you tagged a query and got a table,
this is why, before anything else.

Related: `yo_help dashboards/charts` goes deeper on the dimension-counting rule
and on sorting a named axis; this topic is about answering a question with a
picture.

## Choose the shape from the question

| The question is about… | Use | The x axis is |
|---|---|---|
| ranking or comparing categories | `# bar_chart` | the category |
| change over time | `# line_chart` | the time field |
| whether two measures relate | `# scatter_chart` | the first measure |
| variation across US states | `# shape_map` | the state name |

If none of those is what was asked, **leave it a table**. A chart of eight
columns is worse than the eight columns, and a bar chart whose bars are all the
same height says "no pattern" at the cost of the reader's attention.

## Name the channels

```malloy
# bar_chart { x=brand y=total_sales }
# bar_chart { x=nickname y=flight_count series=destination }
# line_chart { x=order_month y=['sales', 'cost'] }
```

Left unset they are inferred: **x** takes a time dimension if there is one and
otherwise the first dimension, **y** takes the first aggregate, and — the rule
that catches people — **any leftover dimension becomes a colour series**.

So a result with two `group_by` fields and only `x` named will grow a legend you
did not ask for, and one with three or more untagged dimensions is refused
outright:

> Too many dimensions. A bar chart can have at most 2 dimensions: 1 for the x
> axis, and 1 for the series.

Aggregates are exempt — a result may carry as many measures as you like; only
those named in `y` are drawn.

**`# hidden` does not exempt a dimension from that count.** It hides a column in
a table; a hidden `group_by` is still a dimension and will still be promoted to a
series.

*If you need a sort key that is not a channel, make it a MEASURE* —
`aggregate: sort_key is min(month_number)` — because measures can never be
promoted. That is the standard fix for "label it January, order it first".

## Properties worth knowing

| | |
|---|---|
| `size` | `spark`, `xs`, `sm`, `md`, `lg`, `xl`, `2xl`, or `size.width` / `size.height` in pixels |
| `stack` | `# bar_chart.stack` — stack instead of group |
| `zero_baseline` | line charts: force the y axis to include zero |
| `series.limit` | how many series before the rest are dropped (bar 20, line 12) |
| `title`, `subtitle` | a heading on the chart itself |
| `x.limit` | cap the categories drawn |

Channels can also be tagged on the fields instead of in the block, which reads
better when the query is long:

```malloy
# bar_chart
run: flights -> {
  group_by:
    # series
    destination
    # x
    carriers.nickname
  aggregate:
    # y
    flight_count
}
```

## Scatter and maps take fields in ORDER

`# scatter_chart` reads them positionally: **x, y, colour, size, shape**. There
are no channel names to set, so the order of your `group_by`/`aggregate` clauses
is the encoding.

`# shape_map` is **US states only**, and wants **state name first, value
second**. `# segment_map` takes `lat1, lon1, lat2, lon2, colour`.

## Format the numbers

A chart with raw floats on the axis is harder to read than the table it
replaced. These attach to a field, not to the chart:

```malloy
aggregate:
  # currency=usd2m
  total_sales
  # percent
  share_of_sales
  # number="#,##0"
  order_count
```

`# duration`, `# data_volume`, `# link` and `# image` follow the same shape.

## Check it drew

A chart that compiles can still refuse to render — "too many dimensions" happens
at draw time, not compile time. If you ran the query and the caller sees a table
where you expected a chart, the tag did not take: check that it is on its own
line directly above the query, and that you have not left a spare dimension to be
promoted.
