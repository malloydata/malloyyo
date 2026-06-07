@AGENTS.md
@local/CLAUDE.md

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

Create a `local/` directory (gitignored) for your environment files. Name them after the instance, e.g. `local/staging`, `local/main`. Copy `.env.local.example` for the required vars.

```bash
npx dotenv-cli -e local/staging -- npm run dev
```

DB schema push:
```bash
npx dotenv-cli -e local/staging -- npx drizzle-kit push
```

See `local/CLAUDE.md` for instance-specific details (gitignored, private).

## Database & migrations

- **`drizzle-kit push` is INTERACTIVE.** When a change is risky (e.g. adding a
  unique constraint to a table with existing rows) it prompts for confirmation
  and **fails in a non-interactive shell** with `Interactive prompts require a
  TTY terminal`. Either run it in a real terminal, or apply the change with a
  hand-written SQL migration (below) instead.
- **Do NOT run `drizzle-kit generate`.** This repo uses `push`, so the
  `drizzle/meta` journal is stale relative to the live databases. `generate`
  would diff against that stale snapshot and emit a bogus catch-up migration
  that tries to re-create tables that already exist → it fails on apply.
- **Data backfills / data-touching migrations go in `drizzle/manual/NNNN_*.sql`**
  as hand-written, **idempotent** SQL (`ADD COLUMN IF NOT EXISTS`, guarded
  `UPDATE`s, `CREATE … IF NOT EXISTS`). Run once per instance with psql, keeping
  the DB URL out of logs:
  ```bash
  npx dotenv-cli -e local/staging -- bash -c 'psql "$DATABASE_URL" -v code=stg -f drizzle/manual/0001_ltool_slugs.sql'
  ```
  Parameterize per-instance values with psql vars (`-v name=value`, referenced
  as `:'name'`), defaulting them with `\if :{?name} \else \set name … \endif`
  so a passed `-v` isn't overridden. The schema column itself still lives in
  `src/db/schema.ts` so fresh `push` installs stay correct.
- Operator-facing upgrade steps (env vars + which migration to run) belong in
  `UPGRADING.md` — keep it current for the external Guild instance.

## Instance identity

Multiple deployments (main / staging / the external Guild instance) can be
connected to the same Claude client at once. Two env vars disambiguate them:

- `INSTANCE_NAME` — display name; shown in the UI, the MCP `serverInfo.name`,
  and prefixed `[<INSTANCE_NAME>]` onto every tool description so Claude can
  route to the right instance.
- `INSTANCE_CODE` — short slug prefix (e.g. `main`/`stg`/`gld`), **must be
  distinct per instance**. Shareable query slugs are `<code>_<nanoid>`; a slug
  minted on one instance is rejected (with a pointer to the right one) when
  handed to another's `describe_query`/`run_query`.

Defaults are `Malloyyo`/`main`. Set both in the Vercel env (per environment)
**and** mirror them into the matching `local/<instance>` file.

## MotherDuck gotcha

The lowercase `motherduck_token` shell env var must NOT be set — it overrides and conflicts. Unset it before running. The token in the env file is `MOTHERDUCK_TOKEN` (uppercase).

## Vercel deployment notes

- `outputFileTracingIncludes` keys must NOT have `/route` suffix
- DB initialization is lazy (Proxy in src/db/index.ts) to avoid build-time DATABASE_URL access
- `proxy.ts` exports `proxy` function (not `middleware`) — Next.js 16 convention
- After adding npm packages locally, run `npx pnpm install` to sync pnpm-lock.yaml before deploying
- **`next build` needs `DATABASE_URL`** at "Collecting page data" (some API
  routes evaluate it). Build with the instance env, e.g.
  `npx dotenv-cli -e local/staging -- npm run build`.

### The Vercel project has NO connected Git repo

Deploys come from the **local working tree** via the CLI, not git pushes. Two
consequences that cost real time:

- **`vercel env add` does not work from an agent shell.** The CLI auto-detects
  the agent, goes non-interactive, and either loops on a `git_branch_required`
  prompt or errors `Project "malloyyo" does not have a connected Git repository`
  (the branch-scoped form needs a git repo). **Set env vars in the Vercel
  dashboard** (Project → Settings → Environment Variables → tick Production
  and/or Preview). `vercel env ls preview` to read them back works fine.
- The Vercel **MCP server can deploy and read logs but has NO env-var tool**,
  and its `deploy_to_vercel` takes no args (can't target preview). For a
  targeted staging deploy use the CLI.

### Deploy + alias sequence (verified working)

```bash
export PATH="$HOME/.npm-global/bin:$PATH"   # the vercel CLI lives here
unset motherduck_token                       # MotherDuck gotcha, see above
vercel --target preview --yes                # deploys local tree; prints <deploy-url>
vercel alias set <deploy-url> malloyyo-staging.vercel.app   # staging alias
```

- Staging lives at **`malloyyo-staging.vercel.app`** (Preview env). It is NOT
  the auto-generated `malloyyo-<user>-<team>.vercel.app` URL — don't alias to
  that by mistake.
- Production: `vercel --prod` (uses Production env).
- The CLI is already authenticated (`vercel whoami`). It may warn it's outdated;
  `npx vercel@latest …` behaves the same re: the agent/git-repo limits above.

## Planned work

- [ ] Google OAuth (jrtipton commit e338eef8) + OAuth 2.0 for MCP (commits b5fd4668, 2aad16e8, 77d88c80) — do together, needed for claude.ai web MCP integration
- [ ] Bearer token auth on MCP endpoint for infrastructure/API use
- [ ] Malloy models loadable from a git repo URL instead of Claude-generated
