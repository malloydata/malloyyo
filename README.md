# malloyyo

An MCP server that gives AI a **semantic model** of your data — so it returns accurate results, not plausible-looking SQL.

Point an AI at a raw database and it guesses: wrong joins, invented columns, aggregations double-counted on fan-out — and the answers *look* right. Malloyyo puts a [Malloy](https://malloydata.dev) semantic model — the measures, dimensions, and joins defined once and correctly — between the AI and your data. The AI composes queries against that model instead of writing SQL from scratch, so the numbers come back right by construction.

You develop the model locally with the [Malloy CLI](https://github.com/malloydata/malloy-cli) and publish it with the `malloyyo` CLI (or point Malloyyo at a GitHub repo). Malloyyo compiles it against your MotherDuck database and serves it as a personal MCP endpoint for claude.ai, Claude Desktop, or any MCP client — running on Vercel or self-hosted in Docker.

## How it works

```
      ┌─────────────────────────────────────────────┐
      │           GitHub repo (index.malloy)        │
      │   your semantic model, developed with CLI   │
      └────────────────────┬────────────────────────┘
                           │  malloyyo publish
      ┌────────────────────▼────────────────────────┐
      │                 Malloyyo                    │
      │       compile → store → ready               │
      └──────┬─────────────────────────┬────────────┘
             │                         │
      ┌──────▼──────┐           ┌──────▼──────┐
      │   Cloud DB  │           │    Neon     │
      │  or S3/GCS  │           │  Postgres   │
      │             │           │  metadata   │
      │             │           │             │
      │  your data  │           │  datasets   │
      │  + queries  │           │  malloy_    │
      └─────────────┘           │    models   │
             │                  │  users      │
             └──────────────────┘
                           │
      ┌────────────────────▼────────────────────────┐
      │              MCP server  /mcp               │
      │         OAuth 2.1 · 4 analytical tools      │
      └─────────────────────────────────────────────┘
```

### Adding a dataset

Develop your model in a repo with an `index.malloy` at its root, then **publish it with the [`malloyyo` CLI](packages/cli)**:

```bash
malloyyo login <target>     # one-time browser sign-in
malloyyo publish <target>   # bundle *.malloy + malloy-config.json and push
```

The CLI records the git commit it published from; Malloyyo compiles and introspects the model and stores a new version. If it doesn't compile, the push is rejected and the live model is left unchanged.

Alternatively, **point Malloyyo at a GitHub repo** and it pulls `index.malloy` (and any imports) directly — a webhook endpoint (`/api/datasets/<id>/webhook/github`) refreshes it on every push.

### The two databases

| Database | What lives there |
|---|---|
| **Cloud database** (BigQuery, Snowflake, MotherDuck, MySQL, Postgres, Presto, Trino) or **S3/GCS** | Your analytical data |
| **Neon Postgres** | Metadata — `datasets`, `malloy_models`, `malloy_model_files`, `users`, `accounts`, `sessions`, OAuth clients and tokens |

### MCP tools served at `/mcp`

| Tool | What it does |
|---|---|
| `list_sources` | List the Malloy sources you can query on this endpoint |
| `describe_source` | A source's semantic model — measures, dimensions, views, joins |
| `query` | Run a Malloy query; returns rows + a shareable link (`execute: false` for SQL only) |
| `open_share_link` | Resolve a shared link back to its source, question, and Malloy |

The MCP endpoint speaks OAuth 2.1, so claude.ai's remote MCP integration can connect after a one-time authorization flow.

## Developing Malloy models

Use the [Malloy CLI](https://github.com/malloydata/malloy-cli) (`@malloydata/cli`) to write and test semantic models locally, then publish them to Malloyyo with the separate [`malloyyo` CLI](packages/cli). (Two tools: `malloy-cli` authors and compiles; `malloyyo` publishes.)

```bash
npm install -g @malloydata/cli
```

**1. Configure your database connection** in `malloy-config.json` at the root of your model repo — see the [Malloy connection config docs](https://docs.malloydata.dev/documentation/setup/config). Supported databases: BigQuery, DuckDB (incl. MotherDuck), MySQL, Postgres, Snowflake, Databricks, Trino, Presto. Malloyyo reads this same file when it builds your model — the `malloyyo` CLI uploads it on publish, and the GitHub path reads it from the repo root — so one config works everywhere.

**2. Add `.mcp.json`** to your model repo so your AI assistant can compile and test Malloy directly:

```json
{
  "mcpServers": {
    "malloy": {
      "command": "malloy-cli",
      "args": ["mcp"]
    }
  }
}
```

`malloy-cli mcp` runs an MCP server over stdio exposing a `compile_malloy` tool and bundled Malloy language-reference prompts. Claude Code, Claude Desktop, and other MCP clients will pick this up automatically.

**3. Develop your model** — ask your AI to generate and test a Malloy semantic model against your database, or write it yourself and use `malloy-cli compile` / `malloy-cli run` to verify it.

Once the model compiles cleanly, publish it with `malloyyo publish <target>` (or push to GitHub and point Malloyyo at the repo). See [`packages/cli/README.md`](packages/cli/README.md) for the CLI.

## Stack

- **Next.js 16** App Router
- **MotherDuck** — cloud DuckDB; analytical data storage and query engine
- **Neon Postgres** + **DrizzleORM** — metadata and auth state
- **Malloy** (`@malloydata/malloy` + `@malloydata/db-duckdb`) — semantic layer
- **NextAuth v5** + **Google OAuth** — user authentication
- **OAuth 2.1 provider** — MCP authorization for claude.ai, and login for the CLI
- **`malloyyo` CLI** (`packages/cli`) — publish models from a repo over an OAuth-authenticated push endpoint

## Running locally

Copy `.env.local.example` to `local/<instance>` and fill in the blanks:

```bash
DATABASE_URL=postgresql://...          # Neon (or any Postgres)
MOTHERDUCK_TOKEN=...                   # MotherDuck personal token
MOTHERDUCK_DATABASE=malloyyo           # Must be an existing MotherDuck database
APP_BASE_URL=http://localhost:3000
APP_ADMIN_EMAILS=you@example.com
AUTH_SECRET=...                        # openssl rand -base64 32
AUTH_GOOGLE_ID=...                     # Google OAuth client ID
AUTH_GOOGLE_SECRET=...                 # Google OAuth client secret
# GITHUB_TOKEN=github_pat_...          # Optional; needed for private repos
```

```bash
pnpm install
npx dotenv-cli -e local/main -- npx drizzle-kit push   # first run only
npx dotenv-cli -e local/main -- npm run dev
```

Open <http://localhost:3000>.

## Code map

1. **`packages/cli`** + **`src/app/api/datasets/[id]/model/push`** — the `malloyyo publish` path: the CLI bundles and uploads model files; the route compiles, introspects, and stores a versioned model (git provenance in `malloy_models.git_*`).
2. **`src/lib/github.ts`** + **`src/lib/github-refresh.ts`** — the GitHub *pull* path: model loading and webhook-triggered refresh.
3. **`src/lib/malloy.ts`** — single-file and multi-file Malloy compilation and execution via `InMemoryURLReader`.
4. **`src/lib/mcp-tools.ts`** + **`src/app/mcp/route.ts`** — the MCP server. Tools are pure functions; the route is a JSON-RPC dispatcher.
5. **`src/db/schema.ts`** — Drizzle schema for all Postgres tables.
