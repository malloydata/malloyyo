---
description: Setting up a data connection (malloy-config.json)
---

# Setting up a data connection

A model reaches its data through a **connection** declared in
`malloy-config.json` at the **root of the model** (next to `index.malloy`). This
is Malloy's standard connection config — the full reference, with every
connector's properties, is at
<https://docs.malloydata.dev/documentation/setup/config>. The essentials:

## The file

```json
{
  "connections": {
    "mydb": { "is": "duckdb" }
  }
}
```

- A connection has a **name** (the key) and a type (`is`). Sources refer to it by
  that name — `source: x is mydb.table("orders")` or `mydb.sql("SELECT …")` — so
  the name in the config must match the name in the model.
- Supported types (`is`): `duckdb` (incl. MotherDuck), `bigquery`, `postgres`,
  `mysql`, `snowflake`, `databricks`, `trino`, `presto`. Each has its own
  properties — see the full docs.

## Default connections (and when they apply)

Setting `"includeDefaultConnections": true` makes one connection available for
**each registered database type, named by the type** — a `duckdb` connection
named `duckdb`, a `postgres` named `postgres`, and so on. Each uses that
connector's default settings, which for several backends means picking up
credentials from the environment (e.g. BigQuery's application-default
credentials — see the per-connector setup docs). Connections you name explicitly
in `connections` always win; the defaults only fill in types you didn't list.

```json
{
  "includeDefaultConnections": true,
  "connections": { "warehouse": { "is": "postgres", "host": "…" } }
}
```

malloyyo has one rule worth knowing:

- **No `malloy-config.json` at all → defaults are ON.** `duckdb` just works with
  zero setup.
- **Write a `malloy-config.json` and they turn OFF** unless you add
  `"includeDefaultConnections": true`. A config that only defines, say, a
  `postgres` connection will report *No connection named "duckdb"* if a source
  still references `duckdb`.

This is deliberate — your local connections then resolve exactly the way the
published server's will, rather than silently leaning on a default that would not
exist in production. (It differs from `malloy-cli`, which forces the defaults on
unconditionally.)

*No connection named* has one cause that is **not** about your config: if more
than one copy of `@malloydata/malloy` is installed, the connectors register with
one copy and malloyyo reads another, and every connection looks missing. malloyyo
detects that and says so instead — if it doesn't mention duplicate copies, the
problem really is the config. To check by hand: `npm ls @malloydata/malloy`.

Give a connection a **custom name** — not the bare type default — whenever you
have more than one connection of the same type, or need non-default parameters.

## DuckDB and local files (the common case)

DuckDB can either open a **DuckDB database file** or read **local data files**
(CSV, Parquet, …) directly.

**A pre-loaded database file** — point `databasePath` at a `.duckdb` file and
reference its tables by name (an absolute path is safest):

```json
{ "connections": { "warehouse": { "is": "duckdb", "databasePath": "/data/warehouse.duckdb" } } }
```

**Local files, by path** — read a CSV or Parquet file straight into a source.
These paths are **project-relative** — resolved against the model root, so they
survive publishing:

    source: my_csv     is duckdb.table('data/my_file.csv')
    source: my_parquet is duckdb.table('data/my_file.parquet')

`.table()` names a single file. When you need something it can't express — a
glob, a union, any SQL — wrap it in `.sql()` (its paths are project-relative too):

    source: payments is duckdb.sql(
      "SELECT * FROM read_parquet('data/payments-*.parquet')"
    )

The default `duckdb` connection is **in-memory** — nothing persists between runs;
your data lives in the files (or the `databasePath` database) you read.

**MotherDuck:** a DuckDB connection against an `md:` database; set the
`MOTHERDUCK_TOKEN` environment variable.

## Secrets — keep them out of the file

Any property value may be written as `{ "env": "VAR_NAME" }`. It resolves from
`process.env.VAR_NAME` when the connection opens, so passwords and tokens never
get committed:

```json
{
  "connections": {
    "analytics": {
      "is": "postgres",
      "host": "db.internal",
      "databaseName": "analytics",
      "username": "reader",
      "password": { "env": "PG_PASSWORD" }
    }
  }
}
```

(The non-secret property names here are illustrative — each connector's exact
properties are in the full docs. The `{ "env": … }` form is the part that
matters: it works for any value.)

## malloyyo specifics

- **One file, one place.** Only the `malloy-config.json` at the model root is
  read — there is no walk-up to parent directories.
- **Local override:** a `malloy-config-local.json` (do **not** commit it)
  **replaces** `malloy-config.json` entirely when present — your private variant
  for local credentials or a different database.
- **The same file ships to production.** Publishing uploads this exact
  `malloy-config.json`, so it must resolve the same way locally and on the
  server — put anything environment-specific behind `{ "env": … }` rather than
  hard-coding it. That is what makes the local test window faithful to
  production.
- Edits are picked up **without a restart** — the server re-reads the file when
  it changes.

## When a connection will not resolve

Fix the connection **first**: a broken connection yields an empty schema and then
a cascade of misleading `field-not-found` errors — ignore those and fix the
connection. A fast check is to compile a probe and see if it alone compiles:

    source: _probe is mydb.sql("SELECT 1 AS one")
