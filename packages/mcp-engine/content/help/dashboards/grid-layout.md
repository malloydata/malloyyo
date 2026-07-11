---
description: Dashboard grid layout — # dashboard {columns=N} with # colspan and # break to place KPI tiles and charts
---

# Dashboard grid layout (`# dashboard {columns=N}`)

By default a `# dashboard` result flows its KPI tiles and cards and wraps.
Add `{columns=N}` to place them on a fixed **N-column grid** instead — use
`columns=6`, which divides evenly into 2- and 3-wide cards.

**Key mechanic:** a tag placed ABOVE `aggregate:` or `nest:` applies to EVERY
item declared in that block. So you set card widths once per block, not per
field.

```malloy
# artifact { title="Customer Insights" } dashboard {columns=6}
view: customer_insights is {
  where: created_at ~ $PERIOD
  # colspan=2
  aggregate: total_sales, user_count, order_count, average_order_value
  # colspan=3
  nest:
    # break
    # bar_chart
    users_by_spend_tier
    sales_by_traffic_source
    # shape_map
    sales_by_state
    # colspan=6
    recent_orders                      // wide detail table → full width
}
```

## The conventions

- **`# colspan=2` above `aggregate:`** — each KPI / measure tile spans 2 of 6
  columns → 3 tiles per row.
- **`# colspan=3` above `nest:`** — each graph or small table spans 3 → 2 per
  row. Per-item render tags (`# line_chart`, `# bar_chart`, `# shape_map`) still
  go on the individual nested items.
- **`# colspan=6`** — a single wide / many-column table gets its own full-width
  line. Tag that one item; a per-item `# colspan` overrides the block default.
- **`# break` on the FIRST nest item** — starts the graphs on a fresh row, so
  KPI tiles and charts never share one. The renderer splits fields into a new
  grid at each `# break`. Just always add it: it's a no-op when the tiles
  already fill complete rows, and the fix when they don't (e.g. 4 measures
  leave a lone tile a colspan-3 chart would otherwise pack in beside).

`# colspan` only does anything in columns mode — without `{columns=N}` the
layout is free-flow wrap and colspan is ignored. Clamp colspans to `1..N`.

See also `yo_help dashboards/vega-charts` for custom charts, and the fuller
authoring guide surfaced by the local `malloyyo mcp` server.
