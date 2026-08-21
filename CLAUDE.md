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

**Node 24.** CI (`preflight.yml`, `cli-publish.yml`) and Vercel Functions run
node 24, and `mise.toml` pins the checkout to it. A machine whose global default
is older will otherwise build and test on a different runtime than ships.
Non-interactive shells don't run mise's activate hook — use `mise exec -- <cmd>`.

## Tests

```bash
bash scripts/preflight.sh   # everything offline-verifiable (what CI runs)
npm run test:hosted         # the DB-backed integration tests
npm test -w packages/cli    # CLI unit tests (pretest builds the bundle)
```

`test:hosted` (`scripts/hosted-test.sh`) runs `test/hosted-explore.test.ts` (the
hosted explore surface) and `test/publish-flow.test.ts` (the CLI publish flow:
the real `malloyyo` binary → HTTP → the real route handlers). It needs a
Postgres and picks one in this order:

1. `YO_TEST_DATABASE_URL` — an explicit throwaway DB. Deliberately **not** the
   ambient `DATABASE_URL`, which usually points at a dev/staging branch.
2. Docker — an ephemeral `postgres:16-alpine` container (the default, and what
   CI uses).
3. A locally installed Postgres (`initdb`/`pg_ctl`) in a temp dir — so the suite
   runs where there's no Docker daemon (agent sandboxes, macOS runners).

**It is destructive:** it drops and recreates the `public` schema before each
test file. Pointing it at a real database is refused (non-local host, or a DB
with rows) unless `YO_TEST_FORCE=1`. Other knobs: `YO_TEST_BACKEND`,
`PG_TEST_PORT`, `YO_TEST_SKIP_CLI_BUILD=1` (the publish test runs
`packages/cli/dist/index.js`; skip the rebuild if yours is current, or point
`MALLOYYO_CLI_BIN` elsewhere).

## Commits & the DCO check

This repo runs the Probot **DCO** app. It requires every commit to carry a
`Signed-off-by:` trailer whose email matches that commit's **author** (the
committer may stay `Claude`). Opening the PR under a human's account does NOT
satisfy it — the check reads commits, not PR authorship.

**Author and sign off as the person running the session. Never hardcode a
name here.** The DCO is a certification that *that person* has the right to
submit the code; signing it as someone else — the repo owner, a previous
contributor — is a false attestation, and the bot will not catch it (it only
string-matches the trailer against the author field, so a sign-off naming the
wrong person passes just as green as a correct one).

Resolve the identity per session — `mcp__github__get_me` on a remote/hosted
session (the container's git identity is `Claude`, not the human's), or
`git config user.email` locally, where it already is. Default the email to
`<id>+<login>@users.noreply.github.com`, which always maps to that GitHub
account; use another only if they say so.

```bash
git commit --author="<name> <email>" -F -   # message ends with:
#   Co-Authored-By: Claude … (keep — the assist stays visible)
#   Signed-off-by: <name> <email>           (same address as --author)
```

Fixing it after the fact: `git commit --amend --author=… -F -` with the
trailer appended, then `git push --force-with-lease`.

## Database & migrations

**The `drizzle/` journal is the schema path** (since 2026-08-07; before that,
interactive `drizzle-kit push` + hand-run `drizzle/manual/` files, removed
2026-08-12). Boot
applies it with drizzle-orm's `migrate()` (src/lib/migrate.ts, called from
src/instrumentation.ts): fresh databases replay the whole journal, existing
ones get what's pending, concurrent boots serialize on a Postgres advisory
lock (drizzle's migrator does NOT serialize itself — verified empirically),
and a failure fails readiness — both health routes answer 503, never 200 over
a broken migration. **On by default in production, off by default in dev**
(`bootMigrationsEnabled()`): `npm run dev` against a real instance's
`local/<env>` database never applies a working tree's unmerged journal
entries. `RUN_MIGRATIONS_ON_BOOT=0` opts a deployment out (schema managed
out-of-band); `=1` opts a dev server in.

**Boot migrations only work where the process keeps running.** They complete
on a long-lived server — a VM, a container on a host, Kubernetes — and they do
NOT complete on a per-invocation runtime (Vercel Functions, Lambda) or a
container platform that throttles CPU between requests (Cloud Run, Container
Apps, Fargate scaled to zero). The server answers requests before `register()`
resolves (`next start` prints `Ready` in ~50ms, then migrates for ~12s), so
the instance is frozen mid-migration, nothing lands, and `migrationGateError()`
reports "boot migrations have not run" forever. Verified on Vercel 2026-08-20:
the `drizzle` schema was created, the journal table never was, and six cold
starts made no further progress.

**On Vercel the journal is applied by the BUILD**, via the `vercel-build`
script — Vercel runs it in place of `build` when present, with the project's
own env vars, so `DATABASE_URL` is already there:

```json
"vercel-build": "tsx scripts/vercel-build.ts"
```

The script builds first, then applies the journal only for Production by default. A
compile failure therefore cannot mutate the database, while a migration failure still
fails the Vercel build before publication. Vercel caps the whole build step at 45 minutes.
Preview and custom environments skip migrations unless their isolated database is opted
in with `RUN_MIGRATIONS_ON_BUILD=1`; Production can opt out with `=0` only when another
release process owns its schema.

Boot migrations are disabled unconditionally whenever `VERCEL` is present. A stale
`RUN_MIGRATIONS_ON_BOOT=1` cannot override this: without the guard Functions still freeze
mid-migration and `/api/healthz` reports `failed_startup` even when the schema is current.

**Ordering matters.** The build migrates before the new code is promoted, which
is safe for additive entries. An entry that REMOVES something the *currently
live* version still selects takes that version down for the length of the
deploy — 0014 drops `users.slug`, and the live build still lists that column in
`bearer-auth.ts`, `app/mcp/route.ts`, `api/me`, and sign-in, so the outage
spans MCP auth and sign-in rather than one legacy route. Check the pending
entries and plan a window; for future drops, remove the column in a release
*after* the one that stopped selecting it.

## Two health routes, and which is which

- **`GET /api/healthz` — local.** "Is this process alive and did it start up
  correctly?" `migrationGateError()` plus a version string, and **no I/O at
  all**. This is the one routine machinery may poll: hosted instances carry a
  service check against it every 15 seconds. Answers
  `{"status":"ok","version":…}` or a bare `{"status":"failed_startup",…}` 503.
- **`GET /api/health` — deep.** "Is this instance correctly connected to its
  dependencies?" The same readiness gate, then `SELECT 1`. Its callers are
  deliberate ones: the deploy script's post-deploy check, the hosted roll's
  verification gate, an operator diagnosing an alert.

**Nothing on an interval may call the deep route.** It executes a query, and a
hosted instance's Postgres scales to zero — a check every few seconds would
hold every tenant's database awake permanently. That is the entire reason the
two exist separately.

- **To change the schema:** edit `src/db/schema.ts`, then `npx drizzle-kit
  generate --name <what_changed>` (the meta snapshot is current, so generate
  emits a correct increment), review, commit — that's it. New entries run
  **exactly once** per database (journal-recorded, advisory-locked,
  transactional), so plain generated SQL is fine; the idempotent/converge-safe
  style in entries 0001-0012 was an adoption-era need (they re-run on
  pre-journal databases), not an ongoing requirement. **Never edit an applied
  journal file** — src/lib/migrate.test.ts pins their hashes and the journal's
  strictly-increasing `when` order.
- **To apply by hand** (managed instances, local first run — non-interactive,
  keeps the DB URL out of logs):
  ```bash
  npx dotenv-cli -e local/staging -- npx tsx scripts/run-boot-migrations.ts
  ```
  `drizzle-kit push` is retired for schema changes: it records nothing in the
  journal, which is exactly how the pre-2026-08 drift happened
  (`0012_push_catchup.sql` is the archaeology it left behind).
- **Existing databases that predate the journal**: a database with the app
  schema but no `drizzle.__drizzle_migrations` is auto-baselined at 0000 on
  boot, then converged by 0001+ — all written to no-op on newer vintages,
  including databases kept current by hand-running the manual files (the
  normal long-running self-hosted case: the app broke without a current
  schema, so upgraded instances were hand-migrated). 0004 only backports when
  0003 processed a pre-redesign database in the same run, so leftover July
  `*_bak` backups are never re-read. Nothing to do per instance — the next
  production boot converges it.
- **`drizzle/manual/` is gone** (2026-08-12), along with the external workflow
  that applied it. Every instance, managed or self-hosted,
  gets its schema from the journal at boot. A hand-run data fix a journal cannot
  carry has no path today and would need one built; `src/lib/migrate.test.ts`
  carries the hashes the retired baseline file recorded, so an already-applied
  migration still cannot be edited unnoticed.
- **Verification:** `npm run test:migrate` (Docker + a prior `npm run build`;
  wired into preflight) proves journal-replay == `drizzle-kit export` parity,
  pre-journal converge + data survival, the 0001→0004 backport chain on a
  May-2026-vintage database, concurrent-boot serialization, and the
  failed-migration → health-503 → fix → 200 arc on the real standalone server.

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
- After adding npm packages locally, run `npm install` to sync package-lock.json before deploying
- **`next build` needs `DATABASE_URL`** at "Collecting page data" (some API
  routes evaluate it). Build with the instance env, e.g.
  `npx dotenv-cli -e local/staging -- npm run build`.

### Production deploys: `npm run deploy`

**To deploy: `npm run deploy`** (`scripts/deploy.sh`) from the working tree you
want live. The script encodes the whole procedure — build the engine `dist/`
(gitignored), create a staged Production deployment with `--skip-domain`, probe
that deployment's `/api/health`, then promote it and check the Production alias.
The root `build` script also builds the engine, so remote/git-based builds work
without the local pre-build (fixed 2026-07-06 — before that, external deploys
failed with `Cannot resolve @malloyyo/mcp-engine`). Don't re-derive the steps;
run the one command.

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
lockfile sync for the CLI's new @malloydata/malloy-filter dep — remember to
`npm install` after ANY dep change), deployed to production, and both
prod datasets refreshed (babynames v10 / auto_recalls v3 — six v2 dashboards
live). Verified first on the `dev-github-links` prod-fork branch
(local/CLAUDE.md).

Open questions for later: whitelisted charting libs for dashboards
(deliberately deferred); pre-existing dual-install tsc error at
`src/lib/mcp-host.ts:118` (npm root vs pnpm engine copy of @malloydata/malloy).
