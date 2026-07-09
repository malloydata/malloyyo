# mayolo

A web service that turns any dataset into a Malloy MCP endpoint.

User points at a dataset URL → service ingests to blob storage → Claude authors a Malloy semantic model → user gets a personal MCP URL whose tools let any LLM run analytical queries against the dataset.

Inspired by cellardoor's Malloy+MCP shape, generalized to "bring your own dataset."

## Architecture (v0)

```
        ┌──────────────────────────────────┐
        │  Browser (Next.js App Router)    │
        └───────────────┬──────────────────┘
                        │
                        ▼
        ┌──────────────────────────────────┐
        │  Vercel Functions (Node 24)      │
        │  - /api/datasets (register)      │
        │  - /api/datasets/:id (status)    │
        │  - /mcp/:slug (MCP server)       │
        └──┬──────────────────┬────────────┘
           │                  │
           ▼                  ▼
   ┌──────────────┐   ┌─────────────────┐
   │ Vercel       │   │ AI Gateway      │
   │ Workflow     │   │ (Anthropic)     │
   │ (ingest)     │   │ for Malloy      │
   └───┬──────────┘   │ authoring       │
       │              └─────────────────┘
       ▼
   ┌──────────────┐
   │ AWS S3       │  ◄── DuckDB reads via httpfs
   │ (Terraform)  │       (in-process for v0)
   └──────────────┘

   ┌──────────────────────────────────────┐
   │ Neon Postgres (Vercel Marketplace)   │
   │ - users (stub for now)               │
   │ - datasets (url, slug, status)       │
   │ - malloy_models (source, version)    │
   └──────────────────────────────────────┘
```

## Stack

- **Web/API**: Next.js 16 App Router, Node 24, TypeScript, npm
- **DB**: Neon Postgres via Drizzle ORM
- **Blob**: AWS S3, provisioned via Terraform (AWS SDK v3). Swap to R2 later is one env change.
- **Query engine**: DuckDB (in-process via `@duckdb/node-api`)
- **Semantic layer**: Malloy (`@malloydata/malloy`, `@malloydata/db-duckdb`)
- **LLM**: AI SDK v6 + Vercel AI Gateway, `anthropic/claude-opus-4-7`
- **MCP**: `@modelcontextprotocol/sdk` HTTP transport
- **Orchestration**: Vercel Workflow for ingest
- **No auth** in v0 — single hardcoded "user" + unguessable slug per dataset

## Data model

```
users         (id, created_at)
datasets      (id, user_id, source_url, slug, status, schema_json, sample_rows_json, s3_key, created_at)
malloy_models (id, dataset_id, version, source, compiled_at, generated_by)
queries       (id, dataset_id, malloy_source, sql, result_summary, created_at)  -- audit log
```

`status` ∈ `pending | ingesting | introspecting | modeling | ready | failed`.

## MCP tools (mirror cellardoor)

Exposed at `/mcp/<user-slug>` (random ~22-char slug):

- `list_datasets()` → `[{name, description, status}]`
- `describe_semantic_model(dataset)` → Malloy source + table summary
- `compile_analytical_query(dataset, malloy)` → SQL (no execution)
- `run_analytical_query(dataset, malloy)` → rows + types
- `sample_rows(dataset, n?)` → preview rows

## e2e success criteria

1. User pastes the NYC yellow taxi URL into the form
2. Status progresses: pending → ingesting → introspecting → modeling → ready
3. S3 contains the Parquet at `datasets/<id>/data.parquet`
4. Postgres has a `malloy_models` row whose source compiles
5. Hitting `POST /mcp/<slug>` with the MCP `tools/call` envelope for
   `run_analytical_query(dataset='yellow_taxi', malloy='run: trips -> { aggregate: trip_count is count() }')`
   returns `~3000000`
6. A second, more interesting query (e.g. `aggregate: avg_tip is tip_amount.avg() group_by: passenger_count`) returns plausible rows

## Build order

0. Scaffold + git init + plan doc
1. Next.js scaffolding (App Router, TS, Tailwind, src dir, Turbopack)
2. Drizzle schema + Neon connection (driver auto-switches via `DATABASE_URL`)
3. Terraform: S3 bucket + IAM user + access key → write to `.env.local`. S3 client wrapper.
4. Dataset registration: form + `POST /api/datasets` + slug generation
5. Ingest: Vercel Workflow that streams URL → S3 with progress
6. Introspection: DuckDB reads S3 Parquet → schema + 50 sample rows → DB
7. Malloy authoring: prompt Claude with schema+samples → store `.malloy` source → validate by compiling
8. MCP route: `@modelcontextprotocol/sdk` HTTP transport exposing the 5 tools
9. e2e test script: hits the API end-to-end, asserts ready, runs an MCP query, checks result

## Phase 1 (post-e2e)

- Lift DuckDB to a Fargate worker (warm-per-dataset, idle TTL)
- Multi-file datasets / directories
- Auth (Google OAuth via Clerk or Sign in with Vercel)
- Rate-limiting + per-user query budgets
- Iteration UI for Malloy models (user feedback → Claude rewrites)

## Credentials we'll need (and when)

- `DATABASE_URL` — step 2 (Neon free tier or Vercel Marketplace)
- AWS credentials (already configured locally via `~/.aws/credentials` or `aws sso login`) — step 3
  - Terraform provisions: S3 bucket, IAM user with PutObject/GetObject scoped to bucket, access key
  - Outputs: `S3_BUCKET`, `S3_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` written to `.env.local`
- `AI_GATEWAY_API_KEY` (or Vercel-link the project) — step 7

## Repos and accounts

- GitHub: https://github.com/jrtipton/mayolo (private)
- Vercel: link with `vercel link` once we deploy (step 8/9)
- AWS: use existing CLI creds (`aws sts get-caller-identity` to verify)
- GCP: available but not used in v0 (kept as Phase 1 option for Cloud Run worker)
