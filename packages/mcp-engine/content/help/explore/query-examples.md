---
description: Worked query examples — the handful of Malloy shapes that cover almost every question. Read this before writing a query from scratch.
---
# Query Examples

Almost every query is one of the shapes below. Examples use a `flights` source
(dimensions like `carrier`, `distance`, `origin`, `destination`, `state`,
`dep_delay`, `is_small_plane`; measures `flight_count`, `total_distance`).
Substitute the real fields from `describe_source`.

Two rules first: do ordering, limiting, and ranking **in Malloy**, not in client
code — and reuse what the source already publishes before writing your own.

## Run a saved view

The source may already answer the question. A view is invoked by name:

```malloy
run: flights -> by_carrier
```

Refine a saved view in place with `+ { … }` — no need to rewrite it:

```malloy
run: flights -> by_carrier + { where: state = 'CA' }
```

## The workhorse query

When no view fits, write a stage. The vast majority of queries are this shape —
`group_by` the dimensions, `aggregate` the **measures the source already
declares**, `where` to filter, `order_by` to rank. Reuse the measures
`describe_source` lists (here `flight_count`); don't re-derive an aggregate the
source already defines (`count()`):

```malloy
run: flights -> {
  group_by: destination
  aggregate: flight_count
  where: state = 'CA'
  order_by: flight_count desc
  limit: 10
}
```

Every clause is `keyword:` (note the colon, including `order_by:`).

### Aggregate moves

**Filtered aggregate** — `measure { where: … }` filters *that one number* only,
independent of the stage `where:`. Two kinds of `where`: stage-level (which rows
enter the query) vs aggregate-level (which rows a single aggregate counts).

```malloy
run: flights -> {
  group_by: carrier
  aggregate:
    flight_count
    percent_late is flight_count { where: dep_delay > 15 } / flight_count * 100
}
```

**Aggregates from scratch** — *only when the source has no measure for what you
need*, define your own with `is`:

```malloy
run: flights -> {
  group_by: carrier
  aggregate:
    flight_count is count()                -- row count
    destination_count is count(destination) -- DISTINCT destinations
    total_distance is distance.sum()        -- field-first aggregation
}
```

**Percent of total with `all()`** — `all(expr)` ignores the `group_by:` to give
the grand total, so a share is `part / all(part)`:

```malloy
run: flights -> {
  group_by: carrier
  aggregate:
    flight_count
    pct_of_total is flight_count / all(flight_count)
}
```

(`all(expr, dim)` totals within a subgroup — it takes the **alias from
`group_by:`**, not a dotted path.)

### Declare once, reuse — `extend:`

When an expression repeats in a query, define it locally in an `extend:` block:

```malloy
run: flights -> {
  extend: {
    measure: total_distance is distance.sum()
    dimension: state_first_letter is substr(state, 1, 1)
  }
  group_by: state_first_letter
  aggregate:
    total_distance
    small_plane_distance is total_distance { where: is_small_plane }
}
```

**Composing aggregates.** You can't reference one aggregate from another in the
same stage (`aggregate: a is …, b is a/2` fails — *"'a' is not defined"*). To
build a value *from* other aggregates — a ratio, a share — define the parts as
measures in `extend:` (measures **can** reference each other), then use them:

```malloy
run: flights -> {
  extend: {
    measure:
      late_flights is flight_count { where: dep_delay > 15 }
      pct_late is late_flights / flight_count
  }
  group_by: carrier
  aggregate: late_flights, pct_late
  order_by: pct_late desc
}
```

To rank by a computed value, name it (in `aggregate:` or `extend:`) and
`order_by:` that name — `order_by:` takes an output field name, never a raw
expression, and there is no `derive:` step.

## Flat detail rows — `select:`

To fetch raw rows instead of aggregating, use `select:` (the columns to return):

```malloy
run: flights -> {
  select: id, carrier, origin, destination, distance
  where: distance > 1000
  order_by: distance desc
  limit: 100
}
```

A stage is **either** a reduction (`group_by:` / `aggregate:`) **or** a projection
(`select:`) — never both in the same stage. And `select:` **cannot** be combined
with `nest:` in any way; nesting belongs to reductions.

## Nesting — a sub-table per row

`nest:` attaches a whole query to each row of the outer one. This is where
answers get their depth (a per-row ranked breakdown):

```malloy
run: flights -> {
  group_by: origin
  aggregate: flight_count
  nest: by_carrier is {
    group_by: carrier
    aggregate: flight_count
    order_by: flight_count desc
    limit: 5
  }
}
```

## SQL habits that are WRONG in Malloy

| You'd write in SQL | Malloy |
| --- | --- |
| `COUNT(DISTINCT x)` | `count(x)` — `count(distinct x)` is a deprecated error |
| `SUM(x)` | `x.sum()` |
| `SUM(x) OVER ()` | `all(x)` |
| `COUNT(*) FILTER (WHERE c)` / `CASE WHEN` | `count() { where: c }` |
| `SELECT … GROUP BY …` | `group_by:` + `aggregate:` (one stage is reduction OR `select:`, never both) |
