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

**Listing top-N detail rows in a nest — `group_by:`, not `select:`.** A nest is a
reduction, so to nest raw rows (not an aggregate) list the columns with
`group_by:` (`select:` is not allowed inside a nest):

```malloy
run: flights -> {
  group_by: carrier
  aggregate: flight_count
  nest: longest_flights is {
    group_by: origin, destination, distance
    order_by: distance desc
    limit: 5
  }
}
```

## Multi-stage — aggregate, then aggregate again (`->`)

A second `->` runs another stage over the **output** of the first. Reach for it
when you need to aggregate an aggregate — e.g. the **peak** of a per-period
total. You can't write `flight_count.max()` (that's an aggregate of an aggregate
— it errors); compute the per-period total in one stage, then take the max in the
next:

```malloy
run: flights -> {
  group_by: carrier, dep_year
  aggregate: flights_that_year is flight_count
} -> {
  group_by: carrier
  aggregate: peak_year is flights_that_year.max()
}
```

In the second stage `flights_that_year` is an ordinary column (the first stage's
output), so `.max()` is valid. The same shape filters or re-ranks already-
aggregated rows.

## Make a cell a clickable deep link — `# link`

When the answer is "here's the row, go look at it in the source system", tag a
`group_by:`/`select:` field with `# link` so its cell renders as a hyperlink
(in the shareable ltool view and in dashboards). Three forms:

```malloy
run: flights -> {
  # link                                                    -- the value IS a full URL
  group_by: page is concat('https://wikipedia.org/wiki/', origin)
}
```

```malloy
run: flights -> {
  # link { url_template='https://www.flightsfrom.com/$$' }  -- $$ = this cell's value
  group_by: origin
}
```

Link to a value *other* than the one displayed with `field=`, and hide the raw
id with `# hidden` so only the label shows:

```malloy
run: flights -> {
  # link { url_template='https://crm.example.com/person/$$' field=person_id }
  group_by: person_name
  # hidden
  group_by: person_id
}
```

`$$` is substituted anywhere in the template (`.../$$-SJC` works). Sibling
`# image { url_template=… width= height= alt= }` renders the cell as an inline
image instead. Deep links open in a new browser tab.

## SQL habits that are WRONG in Malloy

| You'd write in SQL | Malloy |
| --- | --- |
| `COUNT(DISTINCT x)` | `count(x)` — `count(distinct x)` is a deprecated error |
| `SUM(x)` | `x.sum()` |
| `SUM(x) OVER ()` | `all(x)` |
| `COUNT(*) FILTER (WHERE c)` / `CASE WHEN` | `count() { where: c }` |
| `SELECT … GROUP BY …` | `group_by:` + `aggregate:` (one stage is reduction OR `select:`, never both) |
