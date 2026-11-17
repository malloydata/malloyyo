---
description: Coming from SQL — the Malloy for each SQL construct (joins, CASE, subqueries, EXISTS), and the mistakes SQL habits cause. Read before translating a SQL query.
---
# From SQL to Malloy

Joins, business formulas and keys belong in the source. A query names a source,
then filters, groups and measures; it follows join paths (`orders.customer.region`)
instead of writing joins. Translate the *question*, not the SQL's shape.

## Construct by construct

| SQL | Malloy |
|---|---|
| `FROM a JOIN b ON …` in every query | `join_one:` / `join_many:` once in the source; `b.field` in queries |
| `nation n1, nation n2` (one table, two roles) | two join paths, named once: `dimension: seller_country is seller.nation.name` |
| `IN ('a','b')`, `NOT IN (…)` | `x in ('a', 'b')`, `x not in ('a', 'b')` |
| `LIKE` / `NOT LIKE` | `x ~ 'abc%'` / `x !~ 'abc%'` |
| `BETWEEN a AND b` (inclusive) | `x >= a and x <= b` (`x ? a to b` excludes `b`) |
| a year / month | `d ? @1994`, `d ? @1994-03`; date math `@1998-12-01 - 90 days` |
| `extract(year FROM d)` | `year(d)` |
| `count(DISTINCT x)` | `count(x)` — `count(x)` is always distinct; `count()` counts rows |
| `sum(a * b)` | `sum(a * b)`; `.sum()` follows a field name only: `a.sum()` |
| `sum(CASE WHEN c THEN x ELSE 0 END)` | `x_total { where: c }` (a filtered measure) |
| share: `sum(CASE …) / sum(x)` | `revenue { where: c } / revenue` |
| total via scalar subquery | `all(m)` beside `m` |
| correlated subquery on a key | `all(m, key)` — `m` regrouped to just `key` |
| `= (SELECT max(m) FROM cte)` | `calculate: top is max_window(m)`, then `where: m = top` next stage |
| `WITH cte AS (…)` | a pipeline stage (`-> { … }`) or a model field |
| `EXISTS (child rows where p)` | per-parent `child.count() { where: p }`, then `> 0` next stage |
| `NOT EXISTS (child rows)` | `join_many` to children (kept when none) + count `= 0` next stage |
| `IN (SELECT key … HAVING …)` | `having:` on a measure through the parent's `join_many` |
| `LEFT JOIN … ON k AND p` + `count` | `join_many` + filtered count: `orders.count() { where: p }` |
| `HAVING` against a subquery total | `all()` in stage 1, compare in stage 2's `where:` |

A question with two levels ("count orders that have a late item") is two stages:
group to the inner level, then filter and regroup.

```malloy
run: orders -> {
  group_by: order_id, priority
  aggregate: late_items is items.count() { where: items.is_late }
} -> {
  where: late_items > 0
  group_by: priority
  aggregate: order_count is count()
}
```

Sums and counts through joins are computed at their own table's grain, so a
one-to-many join never double-counts (see `language/aggregate-locality-symmetric-aggregates`).

## SQL habits that break

| Wrote | Result | Write |
|---|---|---|
| `x = 'a' \| 'b' and y > 1` | type error: `\|` binds looser than `and` | `x in ('a', 'b') and y > 1` |
| `(a * b).sum()` | error: methods follow a field name | `sum(a * b)` |
| `having: m > all(m) * 0.01` | compiles; database rejects a window in HAVING | `all(m)` in stage 1, `where:` in stage 2 |
| `count(x)` for a row count | a distinct count | `count()` |
| `aggregate: a is …, b is a / 2` | `'a' is not defined` | define both in `extend: { measure: … }` |
| output named like a model measure | silently shadows it | a new name |
| `join_one: orders is orders …` in a query `extend:` | `Cannot redefine 'orders'` | a new join name |

## Modeling notes

- Source **A** must be defined before a source that joins **A**. To join both ways
  (order → customer and customer → orders), define a join-free base first:
  `source: order_facts is …` (no joins), `customer` joins `order_facts`,
  then `source: orders is order_facts extend { join_one: customer … }`.
- Joins are LEFT. `join_one: x inner on …` needs `##! experimental.join_types` at
  the top of the file; without it, or with the `with` form, `inner` is ignored.
  Use `inner` only where every row is guaranteed a match.
- Check what a query really does by reading its generated SQL.
