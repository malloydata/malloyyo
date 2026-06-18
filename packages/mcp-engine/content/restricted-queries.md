# Working in an explore query

The `query` tool runs your Malloy against a **published model**. You have that
model's entire published surface to work with — and you can build on it.

## You can

- Use everything the model defines: its **sources, dimensions, measures, views,
  joins, and named queries**. `describe_source` shows exactly what's there.
- **Run a named query and refine it** —
  `run: top_carriers + { where: dep_year = 2024 }`.
- **Define your own** dimensions, measures, and **your own sources and joins** —
  as long as they are *derived from the model's sources*. You are not limited to
  the author's fields; compose new ones from them.
- Reference the model's `$NAME` givens and supply values via the `givens` map on
  the `query` call (use `execute: false` to discover which a query needs).
- Use a model field that was itself defined with raw SQL — the author vouched
  for the model's own definitions.

## A few constructs reach outside the model

If you see `restricted-construct-forbidden`, the query used something that
reaches *outside* the published model: pulling in another file (`import`),
opening a raw connection (`connection.table(...)` / `connection.sql(...)`),
writing raw SQL (`name!type(...)` or the `sql_*` functions), declaring new
`given:`s, or setting `##!` compiler flags.

The fix is never to work around it — express the answer in terms of what the
model publishes (define derived sources, joins, dimensions, and measures from
the model's sources). If something fundamental is missing, that's feedback for
the model's author.
