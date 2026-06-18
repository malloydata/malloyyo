---
description: Working with an existing Malloy model
---

# Working with an existing model

An existing model is an `index.malloy` (plus any `.malloy` files it imports) and
a `malloy-config.json`.

## Understand the model

- **Read `malloy-config.json` directly** — it is JSON, so read it as text. It
  lists the connection(s) the model queries against; `yo_help("connection-setup")` explains
  the format (and how to set one up or repair it).
- **Do NOT read `.malloy` as text — compile it.** `compile_file` returns the
  structured model: each source with its fields, joins, views, and named queries,
  plus `problems[]`. That is how you describe what is in the model. (Compiling a
  bare source — no `extend` block — likewise reads a raw table's schema.)

## The loop

Edit a file → `compile_file` → fix `problems[]` → `query`. Pass the model file's
path as `ref`; `execute: false` validates first and reports the givens the query
needs (supplied via `givens`). Query text is restricted — `import`, `given:`
declarations, `connection.table`/`connection.sql`, raw SQL, and `##!` flags
belong in the model file, not the query. When `compile`/`compile_file` returns
`formatted: false`, run `prettify` and save its output. Use project-relative data
paths, not absolute.
