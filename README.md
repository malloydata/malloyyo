# malloyyo

Point at a dataset. Get a Malloy MCP endpoint.

Malloyyo ingests data into MotherDuck, asks Claude to write a [Malloy](https://malloydata.dev) semantic model, and exposes the result as a personal MCP server — so any MCP-capable AI (Claude Desktop, claude.ai, etc.) can run structured analytical queries against your data.

## How it works

```
                    ┌─────────────────────────────────────────────────┐
                    │                 Three ways in                   │
                    │                                                 │
                    │  1. Ingest from URL (Parquet / CSV)             │
                    │  2. Load Malloy model from GitHub repo          │
                    │  3. Build model from existing MotherDuck table  │
                    └────────────────────┬────────────────────────────┘
                                         │
                    ┌────────────────────▼────────────────────────────┐
                    │           Vercel Workflow (durable)             │
                    │     load → introspect → model → ready           │
                    └──────┬────────────────┬───────────────┬─────────┘
                           │                │               │
                    ┌──────▼──────┐  ┌──────▼──────┐  ┌────▼────────┐
                    │  MotherDuck │  │    Claude   │  │    Neon     │
                    │  (DuckDB   │  │  Opus 4.7   │  │  Postgres   │
                    │   cloud)   │  │  writes     │  │  metadata   │
                    │            │  │  Malloy     │  │             │
                    │ analytical │  │  model      │  │ datasets    │
                    │ data store │  │             │  │ malloy_     │
                    │ + queries  │  └─────────────┘  │   models    │
                    └─────────────┘                  │ users       │
                           │                         │ oauth_*     │
                           └──────────────┬──────────┘
                                          │
                    ┌─────────────────────▼───────────────────────────┐
                    │              MCP server  /mcp                   │
                    │         OAuth 2.1 · 5 analytical tools          │
                    └─────────────────────────────────────────────────┘
```

### Adding datasets

**Ingest from URL** — paste a Parquet or CSV URL. A durable Vercel Workflow downloads it into MotherDuck, describes the schema, samples rows, and asks Claude to write a Malloy semantic model (up to 3 compile attempts). The dataset is ready when the model compiles.

**Add from GitHub** — point at a GitHub repo that has an `index.malloy` at its root. Malloyyo fetches the file (and any imports it references), compiles the model, and stores all files. A webhook endpoint (`/api/datasets/<id>/webhook/github`) lets GitHub trigger an automatic refresh on every push.

**Build from existing table** — browse tables already in your MotherDuck database, expand their columns, and ask Claude to write a Malloy model. Same modeling pipeline as URL ingest, just skips the download step.

### The two databases

| Database | What lives there |
|---|---|
| **MotherDuck** (DuckDB cloud) | The actual data — every ingested table lives here, queryable at sub-second latency from Vercel functions via the DuckDB native extension |
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

## Stack

- **Next.js 16** App Router
- **Vercel Workflow** — durable, retryable ingest pipeline
- **MotherDuck** — cloud DuckDB; analytical data storage and query engine
- **Neon Postgres** + **DrizzleORM** — metadata and auth state
- **Malloy** (`@malloydata/malloy` + `@malloydata/db-duckdb`) — semantic layer
- **Claude Opus 4.7** — Malloy model authoring
- **NextAuth v5** + **Google OAuth** — user authentication
- **OAuth 2.1 provider** — MCP authorization for claude.ai

## Running locally

Required `.env.local` vars:

```bash
DATABASE_URL=postgresql://...          # Neon (or any Postgres)
MOTHERDUCK_TOKEN=...                   # MotherDuck personal token (not read_scaling)
MOTHERDUCK_DATABASE=malloyyo           # Must be an existing MotherDuck database
AI_GATEWAY_API_KEY=sk-ant-...          # Anthropic API key
APP_BASE_URL=http://localhost:3000
APP_SECRET=...                         # Shared secret for the login page
AUTH_GOOGLE_ID=...                     # Google OAuth client ID
AUTH_GOOGLE_SECRET=...                 # Google OAuth client secret
# GITHUB_TOKEN=github_pat_...          # Optional; needed for private repos
```

> **MotherDuck gotcha:** the lowercase `motherduck_token` shell env var must NOT be set — it overrides and conflicts with `MOTHERDUCK_TOKEN`.

```bash
pnpm install
cp .env.local.example .env.local   # fill in the blanks
npx dotenv-cli -e .env.local -- npx drizzle-kit push   # first run only
npx dotenv-cli -e .env.local -- npm run dev
```

Open <http://localhost:3000>.

## Suggested reading order

1. **`src/workflows/ingest.ts`** — the four-step durable workflow (load → introspect → model → finish).
2. **`src/lib/claude.ts`** — the Malloy-authoring prompt. Teaches Claude non-obvious Malloy syntax so models compile on the first try more often than not.
3. **`src/lib/duckdb.ts`** — MotherDuck connection, table creation, schema description, sampling, and table listing.
4. **`src/lib/github.ts`** + **`src/lib/github-refresh.ts`** — GitHub model loading and webhook-triggered refresh.
5. **`src/lib/mcp-tools.ts`** + **`src/app/mcp/route.ts`** — the MCP server. Tools are pure functions; the route is a JSON-RPC dispatcher.
6. **`src/lib/malloy.ts`** — single-file and multi-file Malloy compilation and execution via `InMemoryURLReader`.
