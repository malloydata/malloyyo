@AGENTS.md

## Project context

Malloyyo: paste a dataset URL → ingests into MotherDuck → DuckDB introspects schema → Claude authors a Malloy semantic model → personal MCP endpoint for analytical queries.

Forked from jrtipton/mayolo@minimal-core. Key architectural change: **S3/R2 replaced with MotherDuck** for zero-infrastructure deployment.

## Stack

- Next.js 16 App Router + Vercel Workflow (ingest pipeline)
- MotherDuck (DuckDB cloud) — data storage + query engine
- Neon Postgres — metadata (datasets, models, queries, users)
- Malloy (@malloydata/malloy + @malloydata/db-duckdb) — semantic layer
- Anthropic Claude claude-opus-4-7 — Malloy model authoring
- Shared-secret auth via src/proxy.ts (Next.js 16 middleware)

## Local dev

```bash
npx dotenv-cli -e .env.local -- npm run dev
```

Required `.env.local` vars:
- `DATABASE_URL` — Neon Postgres connection string
- `MOTHERDUCK_TOKEN` — read-write personal token (NOT a read_scaling token)
- `MOTHERDUCK_DATABASE` — must be an existing MotherDuck database (e.g. `mayolo`)
- `AI_GATEWAY_API_KEY` — Anthropic API key
- `APP_BASE_URL` — http://localhost:3000 locally
- `APP_SECRET` — shared secret for the login page

DB schema push (first time or after schema changes):
```bash
npx dotenv-cli -e .env.local -- npx drizzle-kit push
```

## MotherDuck gotcha

The lowercase `motherduck_token` shell env var must NOT be set — it overrides and conflicts. Unset it before running. The token in `.env.local` is `MOTHERDUCK_TOKEN` (uppercase).

## Vercel deployment notes

- `outputFileTracingIncludes` keys must NOT have `/route` suffix
- DB initialization is lazy (Proxy in src/db/index.ts) to avoid build-time DATABASE_URL access
- `proxy.ts` exports `proxy` function (not `middleware`) — Next.js 16 convention
- After adding npm packages locally, run `npx pnpm install` to sync pnpm-lock.yaml before deploying

## Planned work

- [ ] Google OAuth (jrtipton commit e338eef8) + OAuth 2.0 for MCP (commits b5fd4668, 2aad16e8, 77d88c80) — do together, needed for claude.ai web MCP integration
- [ ] Bearer token auth on MCP endpoint for infrastructure/API use
- [ ] Malloy models loadable from a git repo URL instead of Claude-generated
