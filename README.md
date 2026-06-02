# malloyyo

Point at a GitHub repo with a Malloy model. Get a personal MCP endpoint for analytical queries.

Malloyyo loads a [Malloy](https://malloydata.dev) semantic model from GitHub, compiles it against your MotherDuck database, and exposes it as an MCP server — so any MCP-capable AI (Claude Desktop, claude.ai, etc.) can run structured analytical queries against your data.

## How it works

```
      ┌─────────────────────────────────────────────┐
      │           GitHub repo (index.malloy)        │
      │   your semantic model, developed with CLI   │
      └────────────────────┬────────────────────────┘
                           │  load + compile
      ┌────────────────────▼────────────────────────┐
      │                 Malloyyo                    │
      │     GitHub → compile → store → ready        │
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
      │         OAuth 2.1 · 5 analytical tools      │
      └─────────────────────────────────────────────┘
```

### Adding a dataset

Point Malloyyo at a GitHub repo that has an `index.malloy` at its root. Malloyyo fetches the file (and any imports it references), compiles the model, and stores all files. A webhook endpoint (`/api/datasets/<id>/webhook/github`) lets GitHub trigger an automatic refresh on every push.

### The two databases

| Database | What lives there |
|---|---|
| **Cloud database** (BigQuery, Snowflake, MotherDuck, MySQL, Postgres, Presto, Trino) or **S3/GCS** | Your analytical data |
| **Neon Postgres** | Metadata — `datasets`, `malloy_models`, `malloy_model_files`, `users`, `accounts`, `sessions`, OAuth clients and tokens |

### MCP tools served at `/mcp`

| Tool | What it does |
|---|---|
| `list_datasets` | Names, schema summaries, and source names for every dataset |
| `describe_semantic_model` | The full Malloy source for a dataset |
| `sample_rows` | Up to 200 raw rows from MotherDuck |
| `compile_analytical_query` | Compile a Malloy snippet → SQL (no execution) |
| `run_analytical_query` | Compile + run; return rows |

The MCP endpoint speaks OAuth 2.1, so claude.ai's remote MCP integration can connect after a one-time authorization flow.

## Developing Malloy models

Use the [Malloy CLI](https://github.com/malloydata/malloy-cli) to write and test semantic models locally before deploying them to Malloyyo via GitHub.

```bash
npm install -g @malloydata/cli
```

**1. Configure your database connection** in `malloy-config.json` at the root of your model repo — see the [Malloy connection config docs](https://docs.malloydata.dev/documentation/setup/config). Supported databases: BigQuery, DuckDB (incl. MotherDuck), MySQL, Postgres, Snowflake, Databricks, Trino, Presto. Malloyyo reads this same file from the root of your GitHub repo when loading a model, so one config works in both places.

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

Once the model compiles cleanly, push to GitHub and add the repo to Malloyyo.

## Stack

- **Next.js 16** App Router
- **MotherDuck** — cloud DuckDB; analytical data storage and query engine
- **Neon Postgres** + **DrizzleORM** — metadata and auth state
- **Malloy** (`@malloydata/malloy` + `@malloydata/db-duckdb`) — semantic layer
- **NextAuth v5** + **Google OAuth** — user authentication
- **OAuth 2.1 provider** — MCP authorization for claude.ai

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

1. **`src/lib/github.ts`** + **`src/lib/github-refresh.ts`** — GitHub model loading and webhook-triggered refresh.
2. **`src/lib/malloy.ts`** — single-file and multi-file Malloy compilation and execution via `InMemoryURLReader`.
3. **`src/lib/mcp-tools.ts`** + **`src/app/mcp/route.ts`** — the MCP server. Tools are pure functions; the route is a JSON-RPC dispatcher.
4. **`src/db/schema.ts`** — Drizzle schema for all Postgres tables.
