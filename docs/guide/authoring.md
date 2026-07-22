# Authoring a model

You don't have to know Malloy, and you don't have to wire up the database by
hand. You need to know your data — what the tables mean, which numbers matter,
and what "correct" looks like. The agent handles the syntax; you handle the
judgment.

---

## 1. Set up the repo

```bash
npm install -g @malloydata/malloyyo
cd my-model-repo
malloyyo init
```

`malloyyo init` writes two things:

- **`.mcp.json`** — so that starting Claude Code in this directory connects it
  to the **author surface**. The server is named `malloyyo_author`, which means
  the mode shows up in every tool call (`mcp__malloyyo_author__…`) and can't be
  confused with anything else you have connected. The file carries no absolute
  paths, so it's safe to commit — the server roots at whatever directory you
  launch from.
- **`index.malloy`** — scaffolded only if you don't already have one. It scans
  your sibling `.malloy` files for sources, queries, and givens and writes a
  starting set of imports and exports. It is a *starting point*; review it.

An existing `.mcp.json` is never clobbered — `init` prints what a fresh one
would look like and leaves yours alone.

## 2. Start the agent

```bash
claude
```

That's it. Because `.mcp.json` is additive, you keep your other MCP servers, and
you land in author mode with these tools:

| tool | what the agent does with it |
|---|---|
| `compile` | Compile Malloy text inline — no file needed. This is the **schema browser**: compiling `source: x is conn.table("users")` returns the full column list and types. |
| `compile_file` | Compile a file and get the structured model back — every source with its fields, joins, views, and `problems[]`. |
| `query` | Run a query against a model file. `execute: false` validates and returns the SQL without touching the warehouse. |
| `prettify` | Format Malloy source. |
| `yo_help` | The guidance library — language reference, patterns, dashboards, connections. |

Then describe what you have:

```
> connect to my Postgres warehouse and build a model from these dbt sources
> add a "net revenue" measure and check it against last quarter's numbers
```

**One thing worth knowing about how the agent works:** it never reads your
`.malloy` files as text. It compiles them. A compile returns the real structure —
fields, types, joins, and errors — where reading text returns a guess. If you
see it compiling something that looks trivially readable, that's why.

## 3. Connect to your data

The connection lives in `malloy-config.json` at the model root.

**DuckDB needs no config at all.** With no `malloy-config.json`, an in-memory
DuckDB connection is available immediately, so the agent can read your local CSV
and Parquet files — and Parquet over plain HTTP, including S3 and GCS — with no
warehouse and no setup. This is the fastest possible start.

For anything else, a small config entry:

```jsonc
{
  "connections": {
    "warehouse": {
      "is": "postgres",
      "host": "db.internal",
      "databaseName": "analytics",
      "username": "reader",
      "password": { "env": "PG_PASSWORD" }
    }
  }
}
```

Two rules that will save you an afternoon:

- **Secrets are references, never values.** Any property can be
  `{ "env": "VAR_NAME" }`, resolved from the environment when the connection
  opens. This file is committed *and* ships to the server on publish, so
  anything environment-specific belongs behind `{ "env": … }` — set the variable
  locally and on the server.
- **Writing a config turns default connections off.** No config file means
  defaults are on and bare `duckdb` works. The moment you write one, only what
  you declare exists, unless you add `"includeDefaultConnections": true`. This
  is deliberate: your local connections then resolve exactly the way the
  published server's will, so "works on my machine" stops being a category of
  bug.

**Fix connection problems before anything else.** A broken connection produces
an empty schema, and an empty schema produces a cascade of confident-looking
`field-not-found` errors that have nothing to do with your model. Probe it
directly:

```malloy
source: _probe is warehouse.sql("SELECT 1 AS one")
```

If that compiles, the connection is good. Full detail:
[`malloy-config.json` reference](reference/malloy-config.md), or
`yo_help("develop/connection-setup")`.

## 4. Build from the bottom up

The shape that works — and the shape the agent will follow if you let it:

**One base source per table.** A base is "what's in this table and what's
computable from it," with no joins. Discover the schema by compiling a bare
stub, then add only the dimensions and measures intrinsic to that one table:

```malloy
// users_base.malloy
source: users_base is warehouse.table("users") extend {
  measure: user_count is count()
}
```

**`index.malloy` assembles and publishes.** It imports the bases, joins them
into the sources consumers actually want, and exports the public surface:

```malloy
import "users_base.malloy"
import "orders_base.malloy"

source: users is users_base extend {
  join_many: orders is orders_base on id = orders.user_id
}

export { users }
```

If your data is files rather than tables, DuckDB lets you name a path as the
table — use **project-relative paths**, not absolute ones, so they survive
publishing:

```malloy
source: users_base is duckdb.table('data/users.parquet')
```

## 5. Export discipline

This is the part people skip and regret.

`export { … }` decides what consumers can see. Without an export statement,
**everything you define is public** — including the staging sources you only
created so something else could build on them.

- Imported names are private by default. Base sources stay internal scaffolding
  unless you export them.
- Add an export list and the surface becomes explicit: what you name is what
  consumers discover.
- The export list is the consumer's menu — what `list_sources` shows, and what
  resolves when someone names a source without qualifying it.

A model is a published artifact. Be deliberate about its edges.

**One caveat, and it matters:** export curates discovery, it does not enforce
access. A caller that names the model explicitly can still describe and query an
unexported source. So keep staging sources out of the export list for clarity —
but don't treat it as a way to hide sensitive data. If something shouldn't be
reachable, keep it out of the model or control it with dataset visibility. See
[Governance](governance.md).

## 6. The loop

```
edit → compile_file → fix problems[] → query (execute: false) → query → read the numbers
```

**The compiler is the oracle.** Correctness here doesn't come from the agent
being clever; it comes from every claim being checked against a compiler and
real data before you accept it. `problems[]` is the mechanism, and it carries a
`help_topic` when there's a known explanation — the agent gets that help inline
on the failing result, so it usually recovers without asking you.

**Your job in the loop is the numbers.** The agent can tell you a query
compiles and returns 4,182 rows. It cannot tell you that net revenue should have
been net of refunds. Check measures against something you already trust — last
quarter's close, a dashboard someone maintains by hand, a number a colleague
would recognize. Do it while the model is small.

A few mechanics that show up in the transcript:

- **Query text is restricted, even in author mode.** `import`, `given:`
  declarations, `connection.table` / `connection.sql`, raw SQL, and `##!` flags
  belong in the model file, not in a query. See [Governance](governance.md).
- **`execute: false` first.** It validates and returns the generated SQL without
  running anything — cheap iteration, and a good way to see what Malloy is
  actually doing.
- **`prettify` after edits.** When a compile reports `formatted: false`, the
  agent formats and saves.

## 7. Repo layout

Where things end up:

```
my-model-repo/
  malloy-config.json     # the connection (committed; secrets by {env:} reference)
  .mcp.json              # written by init — author mode on `claude`
  users_base.malloy      # one base source per table
  orders_base.malloy
  index.malloy           # imports, joins, exports — the published surface
  givens.malloy          # filter declarations, once, shared by dashboards
  dashboards/
    overview.malloy      # one dashboard per file
    overview.jsx         # optional custom component for that dashboard
```

It's a normal git repo. Review it, branch it, and let the git history be the
model's history — `publish` records the commit it shipped from.

## 8. Where the guidance lives

The agent's own documentation is reachable through `yo_help`, and you can ask
for any of it directly:

| namespace | what's in it |
|---|---|
| `develop/*` | getting started, connection setup, working with an existing model |
| `language/*` | the Malloy language reference, split into topics |
| `explore/*` | how to answer questions with a model, query patterns, restricted queries |
| `dashboards/*` | authoring, givens and controls, grid layout, Vega charts, custom components |

`yo_help()` with no topic returns the index. If the agent is stuck on a pattern,
telling it to check `yo_help` is usually faster than explaining the pattern
yourself.

---

**Next:** [Testing a model](testing.md) — a model that compiles is not yet a
model that answers questions.
