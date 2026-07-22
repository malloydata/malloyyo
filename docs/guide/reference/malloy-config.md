# `malloy-config.json`

The file that tells Malloy how to reach your data, and Malloyyo where to publish
it. It is committed, it ships to the server on publish, and it is the same file
Malloy itself reads — the connection format is documented upstream at
[docs.malloydata.dev/documentation/setup/config](https://docs.malloydata.dev/documentation/setup/config).

---

## Where it lives

**At the model root, and nowhere else.** Malloyyo runs config discovery with the
project root as both the start and the ceiling, so there is **no walk-up into
parent directories**. A `malloy-config.json` one level above your repo is not
found; a `malloy-config.json` in a subdirectory is not found either. Put it next
to `index.malloy`.

The root is the directory `-C` points at (or the current directory), for
`malloyyo mcp`, `dashboard dev`, and `lint`. For `publish` it's the `dir`
argument, and the root file is the one gathered and sent.

**`malloy-config-local.json` replaces it entirely.** If that file is present it
wins, and **nothing is merged** — the shared file is ignored wholesale. Whoever
writes the local file is responsible for including everything the model needs.
It is not gathered by `publish` (which sends only `malloy-config.json`), so
**don't commit it**; add it to `.gitignore`.

**Edits are picked up without restarting.** The MCP server stats both filenames
on every call and re-runs discovery when either one's mtime or size changes. You
can fix a connection mid-session and the next tool call uses it.

A file that exists but doesn't parse — or whose top level isn't a JSON object —
is a hard error, not a silent skip.

## `connections`

A map from connection name to its definition. The name is what your Malloy
refers to (`warehouse.table("orders")`); `is` names the backend.

```jsonc
{
  "connections": {
    // Local files, for scratch work and CSV/Parquet.
    "duckdb": { "is": "duckdb" },

    // The warehouse. Secrets are references, never values.
    "warehouse": {
      "is": "postgres",
      "host": "db.internal",
      "port": 5432,
      "databaseName": "analytics",
      "username": "reader",
      "password": { "env": "PG_PASSWORD" }
    },

    // MotherDuck: a DuckDB connection pointed at an `md:` database.
    "md": {
      "is": "duckdb",
      "databasePath": "md:analytics",
      "motherDuckToken": { "env": "MOTHERDUCK_TOKEN" }
    }
  },

  "malloyyo": {
    "main": { "url": "https://malloyyo.example.com",
              "dataset": "ecommerce",
              "malloyyo_token": { "env": "malloyyo_main_token" } }
  }
}
```

`is` is required on every entry, and an unrecognized value is reported with the
list of registered types.

### Connection types

The CLI registers every backend Malloy ships:

| `is` | Backend | Common properties |
|---|---|---|
| `duckdb` | DuckDB, in-process | `databasePath` (default `:memory:`), `workingDirectory` (defaults to the project root), `motherDuckToken`, `additionalExtensions`, `readOnly`, `memoryLimit`, `threads` |
| `bigquery` | Google BigQuery | `projectId`, `billingProjectId`, `serviceAccountKeyPath`, `serviceAccountKey`, `location`, `maximumBytesBilled`, `timeoutMs` |
| `postgres` | PostgreSQL | `host`, `port`, `username`, `password`, `databaseName`, `connectionString`, `ssl` |
| `mysql` | MySQL | `host`, `port`, `user`, `password`, `database` |
| `snowflake` | Snowflake | `account`, `username`, `password`, `role`, `warehouse`, `database`, `schema`, `privateKey`, `privateKeyPath`, `privateKeyPass` |
| `databricks` | Databricks SQL | `host`, `path`, `token`, `oauthClientId`, `oauthClientSecret`, `defaultCatalog`, `defaultSchema` |
| `trino` | Trino | `server`, `port`, `catalog`, `schema`, `user`, `password`, `ssl`, `session`, `extraCredential`, `extraHeaders`, `source` |
| `presto` | Presto | `server`, `port`, `catalog`, `schema`, `user`, `password` |

Every type also accepts `setupSQL`, run when the connection opens. The upstream
[configuration reference](https://docs.malloydata.dev/documentation/setup/config)
is authoritative for the full property list.

**MotherDuck is DuckDB.** Use `is: "duckdb"` with a `databasePath` of
`md:<database>` and a `motherDuckToken`. Note this is separate from the server's
own `MOTHERDUCK_TOKEN` variable, which points the *instance's built-in* DuckDB
connection at MotherDuck — see [environment variables](environment.md). A model
that declares its own `md` connection doesn't depend on that.

**DuckDB paths should be project-relative.** `workingDirectory` defaults to the
project root, so `duckdb.table('data/users.parquet')` resolves the same way
locally and on the server. Absolute paths do not survive publishing.

## The defaults rule

This one is Malloyyo-specific and it surprises people.

| Situation | Default connections |
|---|---|
| No `malloy-config.json` | **On.** A bare `duckdb` connection exists, plus a bare entry for every other registered backend. |
| A `malloy-config.json` exists | **Off**, unless it sets `"includeDefaultConnections": true`. Only what you declare exists. |

With no config file at all, Malloyyo builds a config with
`includeDefaultConnections: true` — which is why an agent can point at your local
CSV and Parquet files the moment you start, with no setup. The moment you write
a config file, that opt-in goes away unless you restate it:

```jsonc
{
  "includeDefaultConnections": true,
  "connections": {
    "warehouse": { "is": "postgres", "host": "db.internal" }
  }
}
```

**Why the default flips.** Off is the honest setting: your local connections then
resolve exactly the way the published server's will, because the server reads the
same file. If bare `duckdb` kept working locally after you'd declared a warehouse,
you'd be one `duckdb.table(…)` away from a model that works on your machine and
fails in production. Turn defaults back on deliberately, when you actually want
scratch DuckDB alongside the real thing — or just declare `"duckdb": { "is":
"duckdb" }` explicitly, which is the clearer signal.

Fabrication is by *name*: a default entry is added for each registered type
unless a connection with that name already exists, whatever its `is`.

## `{ "env": "VAR_NAME" }`

**Any property value may be an environment reference** instead of a literal:

```jsonc
"password": { "env": "PG_PASSWORD" }
```

It is resolved from the process environment **when the connection opens** — not
when the file is read, and not when the model is published. A missing variable
fails at query time.

This matters because **the same file ships to production**. `publish` sends your
root `malloy-config.json` along with the model, and the server compiles against
it. So:

- **Never commit a secret value.** Put every credential behind `{ "env": … }`.
- **Anything environment-specific goes behind it too** — hostnames, database
  names, ports that differ between your laptop and the warehouse.
- **Set the same variable names on both sides.** Locally in your shell or env
  file, and on the server. A model publishes fine with an unset variable and then
  fails the first time someone asks a question.

## The `malloyyo` targets block

Publish targets live under a `malloyyo` key in the same file:

```jsonc
{
  "connections": { /* … */ },
  "malloyyo": {
    "main":    { "url": "https://malloyyo.example.com",
                 "dataset": "ecommerce",
                 "malloyyo_token": { "env": "malloyyo_main_token" } },
    "staging": { "url": "https://malloyyo-staging.example.com",
                 "dataset": "ecommerce_staging",
                 "malloyyo_token": { "env": "malloyyo_staging_token" } }
  }
}
```

| Key | Meaning |
|---|---|
| `url` | The instance's base URL. Trailing slashes are stripped. |
| `dataset` | The dataset name on that instance. It must already exist — publishing does not create it. |
| `malloyyo_token` | `{ "env": "VAR_NAME" }`. **Only the variable name is committed**, never a token. Used for CI; interactively you don't need it. |

If you'd rather keep publish targets out of the connection config, a standalone
**`malloyyo.json`** at the same root works identically — there, the whole file
*is* the target map, with no `malloyyo` wrapper. `malloy-config.json` is checked
first; the standalone file is the fallback.

**Login is per instance, not per target.** A token is stored keyed by instance
URL, so several targets pointing at the same `url` share one session. That's why
`malloyyo login` takes a target name *or* a raw URL, and can be omitted when
your config has one target — or several that all share one URL. See
[`login`](cli.md#login-and-logout).

**Token precedence** for `publish` and `status`: the `--token` flag, then the
env var named here, then your stored login session. See
[Token precedence](cli.md#token-precedence).

## Troubleshooting

**Fix the connection before you debug anything else.** A broken connection
returns an empty schema, and an empty schema produces a cascade of
confident-looking `field-not-found` errors on fields that are perfectly fine.
The real error is the first one, and it's about the connection.

Probe the connection directly — this compiles only if the connection actually
opened:

```malloy
source: _probe is warehouse.sql("SELECT 1 AS one")
```

Config problems arrive on **two channels**, and Malloyyo surfaces both as
problems rather than swallowing either:

| Channel | What it catches |
|---|---|
| A throw out of discovery | Malformed JSON, or a top level that isn't a JSON object. |
| The config's own log | Validation warnings — a missing `is`, a non-string `is`, an unknown connection type (reported with the list of registered ones), bad property shapes. |

Other things that look like model bugs but aren't:

| Symptom | Cause |
|---|---|
| A connection that worked yesterday is now unknown | You added a `malloy-config.json`, which turned default connections off. Declare it, or set `"includeDefaultConnections": true`. |
| Works locally, fails on the server | A property that should be an `{ "env": … }` reference is a literal, or the variable isn't set on the server. |
| Your config seems ignored | A `malloy-config-local.json` is present and replaces it entirely — or the file isn't at the model root, and there is no walk-up. |
| A path resolves locally and not after publish | An absolute filesystem path. Use project-relative paths; DuckDB's `workingDirectory` defaults to the project root. |

---

**Related:** [CLI reference](cli.md) · [environment variables](environment.md) ·
[Authoring a model](../authoring.md) · [Publishing](../publishing.md) ·
[Malloy configuration docs](https://docs.malloydata.dev/documentation/setup/config)
