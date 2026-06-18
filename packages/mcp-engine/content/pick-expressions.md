---
description: pick expressions — Malloy's CASE/if-then-else
---

`pick` is Malloy's equivalent of SQL `CASE WHEN`. Each branch is its own
`pick` keyword; the `else` clause catches the remainder.

There are two forms of pick. In the first the `when` expression is any
boolean expression.

```malloy
    pick 'Female' when upper(first_name) in ('JENNIFER', 'ELIZABETH', 'AMY', 'JESSICA')
    pick 'Male'   when upper(first_name) in ('JAMES', 'JOHN', 'ROBERT', 'MICHAEL')
    else 'Unknown'
```

## Example usage in a query

```malloy
run: payments -> {
  group_by: tier is
    pick 'high'   when total_amount > 10000
    pick 'medium' when total_amount > 1000
    else 'low'
  aggregate: payment_count is count()
}
```

## Common mistakes

- **Every branch needs its own `pick` keyword** — there is no `when … then`:
  ```malloy
  -- WRONG:
  pick 'a' when x = 1 'b' when x = 2 else 'c'

  -- RIGHT:
  pick 'a' when x = 1
  pick 'b' when x = 2
  else 'c'
  ```

- **`else` is required** when the branches don't cover all cases — omitting it
  returns `null` for unmatched rows.
