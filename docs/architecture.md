# How Malloyyo works

```
   MCP client (claude.ai)            Browser (you)
           │ OAuth 2.1                     │ Google sign-in
   ┌───────▼──────────┐          ┌─────────▼─────────┐
   │  MCP server /mcp │          │      Web UI       │
   │ analytical tools │          │  datasets · ltool │
   └───────┬──────────┘          └─────────┬─────────┘
           └──────────────┬────────────────┘
                          │  compile · run             ┌────────────────────┐
                          │                            │  Authoring Models  │
                          │                            │   • Malloyyo CLI   │
                          │                            │   • Claude         │
                          │                            └─────┬───────────┬──┘
                          │                          push    │           │ develop
   ┌──────────────────────▼───────────────────────┐  (deploy)|           │
   │                   Malloyyo                   │◀────────┘           │
   │        load · compile · store · serve        │                      │
   └──────┬─────────────────────────────┬─────────┘                      │
          │                             │                                │
   ┌──────▼──────┐             ┌────────▼────────┐                       │
   │    Neon     │             │  Analytical DB  │◀─────────────────────┘
   │  Postgres   │             │  • BigQuery     │  direct (dev)
   │  metadata   │             │  • MotherDuck   │
   │             │             │  • Snowflake    │
   │  datasets   │             │  • Databricks   │
   │  malloy_    │             │   (or S3/GCS)   │
   │    models   │             │                 │
   │  users      │             │  your data      │
   └─────────────┘             └─────────────────┘
```


## The two databases

| Database | What lives there |
|---|---|
| **Cloud database** (BigQuery, Snowflake, MotherDuck, MySQL, Postgres, Presto, Trino) or **S3/GCS** | Your analytical data |
| **Neon Postgres** | Metadata — `datasets`, `malloy_models`, `malloy_model_files`, `users`, `accounts`, `sessions`, OAuth clients and tokens |

## MCP tools served at `/mcp`

| Tool | What it does |
|---|---|
| `list_sources` | List the Malloy sources you can query on this endpoint |
| `describe_source` | A source's semantic model — measures, dimensions, views, joins |
| `query` | Run a Malloy query; returns rows + a shareable link (`execute: false` for SQL only) |
| `open_share_link` | Resolve a shared link back to its source, question, and Malloy |

The MCP endpoint speaks OAuth 2.1, so claude.ai's remote MCP integration can connect after a one-time authorization flow.


## Stack

- **Next.js 16** App Router
- **Your Analytical Database** —  Most SQL based analytical data storage and query engines
- **Neon Postgres** + **DrizzleORM** — metadata and auth state
- **Malloy** (`@malloydata/malloy` + `@malloydata/db-duckdb`) — semantic layer
- **NextAuth v5** + **Google OAuth** — user authentication
- **OAuth 2.1 provider** — MCP authorization for claude.ai, and login for the CLI
- **`malloyyo` CLI** (`packages/cli`) — publish models from a repo over an OAuth-authenticated push endpoint

## Code map

1. **`packages/cli`** + **`src/app/api/datasets/[id]/model/push`** — the `malloyyo publish` path: the CLI bundles and uploads model files; the route compiles, introspects, and stores a versioned model (git provenance in `malloy_models.git_*`).
2. **`src/lib/github.ts`** + **`src/lib/github-refresh.ts`** — the GitHub *pull* path: model loading and webhook-triggered refresh.
3. **`src/lib/malloy.ts`** — single-file and multi-file Malloy compilation and execution via `InMemoryURLReader`.
4. **`src/lib/mcp-tools.ts`** + **`src/app/mcp/route.ts`** — the MCP server. Tools are pure functions; the route is a JSON-RPC dispatcher.
5. **`src/db/schema.ts`** — Drizzle schema for all Postgres tables.
