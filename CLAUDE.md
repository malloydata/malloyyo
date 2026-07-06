@AGENTS.md
@local/CLAUDE.md

## Project context

Malloyyo: load a Malloy semantic model from a GitHub repo → Malloy runs analytical queries on DuckDB (the model attaches its own data sources) → a personal MCP endpoint that claude.ai (and other MCP clients) query.

Forked from jrtipton/mayolo@minimal-core.

## Stack

- Next.js 16 App Router
- Malloy (@malloydata/malloy) — semantic layer + query engine. Runs on DuckDB by default (@malloydata/db-duckdb, in-memory); models can attach their own warehouses via the bundled connectors (BigQuery, Postgres, MySQL, Snowflake, Trino). MotherDuck is optional — set `MOTHERDUCK_TOKEN` to use an `md:` connection.
- Malloy models are **loaded from a GitHub repo** (src/lib/github.ts; `GITHUB_TOKEN` only for private repos), not generated.
- Neon Postgres — metadata (datasets, models, queries, users)
- Auth via src/proxy.ts (Next.js 16 middleware): Google/Okta sign-in + OAuth 2.0 / bearer tokens on the MCP endpoint.

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

## Vercel deployment notes

- `outputFileTracingIncludes` keys must NOT have `/route` suffix
- DB initialization is lazy (Proxy in src/db/index.ts) to avoid build-time DATABASE_URL access
- `proxy.ts` exports `proxy` function (not `middleware`) — Next.js 16 convention
- After adding npm packages locally, run `npx pnpm install` to sync pnpm-lock.yaml before deploying
- **`next build` needs `DATABASE_URL`** at "Collecting page data" (some API
  routes evaluate it). Build with the instance env, e.g.
  `npx dotenv-cli -e local/staging -- npm run build`.

### Production deploys: `npm run deploy`

**To deploy: `npm run deploy`** (`scripts/deploy.sh`) from the working tree you
want live. The script encodes the whole procedure — build the engine `dist/`
(gitignored), `vercel --prod`, then a `/api/health` check. The root `build`
script also builds the engine, so remote/git-based builds work without the
local pre-build (fixed 2026-07-06 — before that, external deploys failed with
`Cannot resolve @malloyyo/mcp-engine`). Don't re-derive the steps; run the one
command.

**Which project** is decided by the gitignored `.vercel` link
(`vercel link --project <name>`), so each checkout/instance targets its own
(e.g. `mtoyyo-worldcup`, `malloyyo`, `motherduckyo`) with nothing committed. To
deploy a *different* project, relink first:

```bash
export PATH="$HOME/.npm-global/bin:$PATH"   # the vercel CLI lives here
vercel link --project motherduckyo --yes    # change target
npm run deploy
vercel link --project malloyyo --yes        # restore the usual link
```

`vercel --prod` builds **remotely** using the project's own env vars and deploys
the **current working tree** (not GitHub) — check out the code you want live
first. Merging to `main` deploys nothing (the git auto-deploy hook was removed
2026-06-10); pushing a branch / opening a PR creates no preview either. For a
staging build, use the manual preview + alias flow below.

Historical env-var note (still true for any preview build you trigger): preview
builds get only **Preview**-scoped env vars, so they fail at "Collecting page
data" with `Missing required env var: DATABASE_URL` unless `DATABASE_URL` (and
the rest) are set in the **Preview** environment, separate from Production.

Env-var notes:

- Prefer the Vercel **dashboard** for env vars (Project → Settings → Environment
  Variables → tick Production and/or Preview). `vercel env add` from an agent
  shell was historically blocked by the no-git-repo error; with the projects now
  git-connected the CLI form can work, but the dashboard stays the reliable path.
  `vercel env ls <env>` to read back works fine.
- The Vercel **MCP server** can deploy and read logs but has **no env-var tool**.

### Manual deploy + staging alias (CLI fallback, still valid)

```bash
export PATH="$HOME/.npm-global/bin:$PATH"   # the vercel CLI lives here
vercel --target preview --yes                # deploys local tree; prints <deploy-url>
vercel alias set <deploy-url> malloyyo-staging.vercel.app   # staging alias
```

- Staging lives at **`malloyyo-staging.vercel.app`** (malloyyo Preview env). It
  is NOT the auto-generated `malloyyo-<user>-<team>.vercel.app` URL — don't alias
  to that by mistake.
- Production: **manual `vercel --prod` per project** (see "Production deploys are
  MANUAL" above) — merging to `main` no longer deploys.
- The CLI is already authenticated (`vercel whoami`).

## Planned work

### Dashboard artifacts v2 — SHIPPED 2026-07-06 (PR #65, deployed to prod)

The dashboard system was reworked end-to-end (design doc: `docs/repo-artifacts.md`,
authoring guide surfaced over MCP: `packages/cli/src/dashboard-guidance.ts`).
Current state, all verified locally (typechecks, `malloyyo lint`, CLI e2e,
headless-browser interaction tests):

- **Model is the whole contract.** No manifest.json: a dashboard is a top-level
  query tagged `# artifact { name= title= givens{…} }` (givens block = per-dashboard
  starting values). Filters are `filter<T>` givens applied with `~` (empty
  expression = no filter); `# tags` on the declarations drive controls —
  `label`, `control=select`, `range_min/max`, and the structured
  `suggest { source=X dimension=Y }` / `suggest { query=Q dimension=Y }`
  (dimension ⇒ server-side typeahead: `base + { where: lower(f) ~ f'…%' }`).
  Engine helpers: `packages/mcp-engine/src/artifacts.ts` + `given-specs.ts`.
- **One frame runtime** (`packages/cli/src/frame-runtime/`): bridge, `Panel`,
  hooks (`useGiven`/`useOptions`/`useQuery`), headless widgets
  (`Controls`/`Given`/`Select`/`Search`/`Range`/`Checkbox`, `--dash-*` CSS vars),
  `filters` helpers (on `@malloydata/malloy-filter` — escaping matters:
  `'Tesla, Inc.'` raw parses as alternatives). Dev server bundles it from
  source; the hosted app gets it via `scripts/build-dashboard-vendor.mjs` →
  `public/dashboard-vendor.js` (`window.__DASH_RUNTIME__`), so
  `src/lib/dashboards/frame-source.ts` is gone. Dashboards import
  `@malloyyo/dashboard` (esbuild-shimmed). A tag-only query renders the
  runtime's DefaultDashboard — zero JS.
- **Restricted queries are the governance** for arbitrary Malloy from
  dashboards (suggestions, `<Panel malloy=…/>`, `runData`) — same contract as
  the explore MCP surface.
- **Reference repos** (all converted, uncommitted): `examples/babynames`,
  `~/dev/malloyyo-babynames` (incl. a tag-only `name_trend` dashboard),
  `~/dev/malloyyo-auto-recalls` (curated `suggest {query=…}`, Checkbox, empty
  filter = All).

Shipped: sample repos pushed to main, this repo landed via PR #65 (+ a
pnpm-lock sync for the CLI's new @malloydata/malloy-filter dep — remember to
`npx pnpm install` after ANY dep change), deployed to production, and both
prod datasets refreshed (babynames v10 / auto_recalls v3 — six v2 dashboards
live). Verified first on the `dev-github-links` prod-fork branch
(local/CLAUDE.md).

Open questions for later: whitelisted charting libs for dashboards
(deliberately deferred); pre-existing dual-install tsc error at
`src/lib/mcp-host.ts:118` (npm root vs pnpm engine copy of @malloydata/malloy).
