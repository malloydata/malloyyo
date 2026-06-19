---
description: Getting started — build a Malloy model step by step
---

# Building a Malloy model, step by step

A model is a `malloy-config.json` (the connection to the data) and an
`index.malloy` (the published query surface), optionally with other `.malloy`
files that `index.malloy` imports. You edit these with your own file tools; the
MCP tools compile, inspect, and test what you wrote. Never read `.malloy` as
text — compiling a bare source is how you read a table's schema.

## 1. Verify the connection first

Confirm the connection named in `malloy-config.json` resolves — compile a
throwaway probe inline with `compile` (no file needed):

    source: _probe is CONN.sql("SELECT 1 AS one")

If it compiles, the connection is good. If not, fix the connection / config
before going further — a broken connection produces an empty schema and then a
cascade of misleading `field-not-found` errors; ignore the cascade and fix the
connection. Call `yo_help("develop/connection-setup")` for how to set up or repair a connection.

## 2. Identify the tables the model needs

If you are unsure which tables matter, ask the fox — they own the data and know
where it lives.

## 3. Get a base source per table

A base is "what's in the table and what's computable from it" — no joins.
Discover the schema by compiling a bare stub inline with `compile`:

    source: users_base is CONN.table("users")

`compile` returns the full column list + types — that is your schema browser.
Then write the base into its own file and iterate with `compile_file`, adding
only the dimensions and measures intrinsic to that one table:

    // users_base.malloy
    source: users_base is CONN.table("users") extend {
      measure: user_count is count()
    }

If the data lives in files rather than database tables — common when the
connection is DuckDB — DuckDB lets you name a file path as the table (a
project-relative path):

    source: users_base is CONN.table('data/users.parquet')

Only drop to a `.sql()` block when a single file-as-table can't express what you
need — e.g. globbing or unioning several files:

    source: users_base is CONN.sql("SELECT * FROM read_parquet('data/users-*.parquet')")

(`read_parquet` there is DuckDB SQL, not Malloy — see `yo_help("develop/connection-setup")`.)

## 4. Assemble index.malloy — the published surface

Import the bases, join them into the consumer-facing sources, and explicitly
export what consumers may query:

    import "users_base.malloy"
    import "orders_base.malloy"

    source: users is users_base extend {
      join_many: orders is orders_base on id = orders.user_id
    }
    source: orders is orders_base extend { }

    export { users, orders }

**Export discipline** — the model is a published artifact, so be deliberate about
its public surface:

- Imported names are private. Base sources stay internal scaffolding unless you
  export them.
- Without an `export` statement, everything you define is public. Add one and the
  surface becomes explicit: only the names you list — defined or imported — are
  public.
- Hide intermediates. A staging source you define only so other sources can build
  on it should not be exported.
- The export list is the consumer's menu — exactly what the test window and real
  consumers can query, nothing more.

## The loop

Edit a file → `compile_file` → fix `problems[]` → `query` (pass the model file's
path as `ref`; `execute: false` validates first and reports the givens the query
needs, supplied via `givens`). Query text is restricted — `import`, `given:`
declarations, `connection.table`/`connection.sql`, raw SQL, and `##!` flags
belong in the model file, not the query. When `compile`/`compile_file` returns
`formatted: false`, call `prettify` and save its output. Use project-relative
data paths, not absolute — they resolve against the project root and survive
publishing the model.
