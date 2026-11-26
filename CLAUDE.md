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

**The dev container** (`devcontainer/`, `docs/devcontainer.md`) is **for model
repos, not for this one** — `malloydata/malloyyo-ecommerce`,
`malloydata/malloyyo-babynames` and their like. This repo only builds and
publishes the image (`ghcr.io/malloydata/malloyyo-devcontainer`, via
`.github/workflows/devcontainer.yml`): Claude Code, the Malloy/Claude VS Code
extensions, the `malloyyo` CLI, Node 24, Playwright/Chromium, `gcloud`/`bq`. The
source sits in `devcontainer/` rather than `.devcontainer/` precisely so nothing
opens *this* repo in it. A model repo gets its own `.devcontainer/devcontainer.json`
from **`malloyyo init`** (template:
`packages/cli/src/templates/devcontainer/devcontainer.json`, written only when the
repo has none); the extensions and ports ride along in the image's
`devcontainer.metadata` label, so that file stays one `image` line.

**Node 24.** CI (`preflight.yml`, `cli-publish.yml`) and Vercel Functions run
node 24, and `mise.toml` pins the checkout to it. A machine whose global default
is older will otherwise build and test on a different runtime than ships.
Non-interactive shells don't run mise's activate hook — use `mise exec -- <cmd>`.
The two images pin an exact release — `Dockerfile` (`FROM node:<x.y.z>`) and
`devcontainer/Dockerfile` (`NODE_VERSION`) — so what they run is readable from
the tree rather than from a publish date; bump both together, and Vercel's
build log (`node -v` in `vercel-build`) and the `[startup] node` line at boot
say what each deployment got.

## Tests

```bash
bash scripts/preflight.sh   # everything offline-verifiable (what CI runs)
npm run test:hosted         # the DB-backed integration tests
npm run load-test           # list_sources/query cost vs dataset count, and a concurrent burst
npm test -w packages/cli    # CLI unit tests (pretest builds the bundle)
node scripts/audit-gate.mjs # CI's dependency gate (needs the registry)
```

The audit gate fails only when `npm audit fix` would change the lockfile —
an advisory whose fix is already inside package.json's ranges. Advisories
that need a major bump or have no fix are printed, not failed, so the gate
is never red over something nobody can act on. `preflight.yml` runs it
before the preflight script.

`load-test` (`scripts/load-test.ts`, via `hosted-test.sh --run`) seeds
`LOAD_DATASETS` (100) datasets into the same kind of throwaway Postgres and
calls the hosted explore surface in process: list_sources, describe_source and
query latency, then a burst of `LOAD_CONCURRENCY` (100) dashboard-shaped
queries. A call unsettled after `LOAD_DEADLINE_S` (180) counts as hung and
exits 2. Run it before and after anything that touches pooling or the catalog
(`docs/model-cache-and-pooling.md`).

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
"vercel-build": "tsx scripts/run-boot-migrations.ts && npm run build"
```

A build takes as long as it takes, so the migration finishes; a failed
migration fails the build, so nothing ships onto a schema it can't run on. It
covers **every** Vercel build — dashboard redeploys and git-triggered deploys
included, not just `npm run deploy`. `npm run build` is untouched, so the
Docker image and CI are unaffected.

Each Vercel environment also needs **`RUN_MIGRATIONS_ON_BOOT=0`**. This is not
optional: without it the functions still attempt a boot migration and still get
frozen, so `/api/healthz` reports `failed_startup` even when the schema is
current and the app is serving correctly (verified 2026-08-20).

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

## Credentials that reach the API

Three different things authenticate a caller, and conflating them is the easy
mistake:

- **A session** (browser) — Auth.js database sessions, `getSessionUser()`.
- **An OAuth access token** — `malloyyo login` and claude.ai connections. 24h,
  refreshable, and scoped by what the client asked for on the consent screen:
  `login` requests `mcp publish`, a claude.ai connection requests `mcp` and so
  **cannot publish**. A grant whose stored scope is unrecognized — including
  every grant issued before publishing had a scope of its own — reads as
  `mcp` alone (`grantedScopes`, src/lib/api-token-scopes.ts): a credential must
  never gain reach from an older vintage. The upgrade path for someone whose
  saved login predates this is one `malloyyo login`, which the CLI's 403 says.
- **A personal API token** — minted by any member at `/settings/tokens`, read by
  the CLI from `$MALLOYYO_TOKEN`. Long-lived (expiry optional, "never" allowed),
  hashed, revocable, and scoped: `publish` (model push + status) or `mcp`
  (query). Format `myo_<INSTANCE_CODE>_<secret>`, which is what lets the CLI
  diagnose "that variable holds a different secret" and "that token is from
  another instance" instead of relaying a bare 401.

**Both token kinds resolve through one place — `src/lib/bearer-auth.ts`
(`requireBearer` / `resolveBearer`).** Don't call `validateAccessToken` from a
route: that skips the API-token path, the per-request `authorize()` re-read, and
the scope check. Scopes are one vocabulary for both
(`src/lib/api-token-scopes.ts`), so the consent screen and the token form
render the same sentences. **Publishing is admin-only** (`canAuthor`, i.e. the
admin role): publishing, creating repos and datasets, branch previews, and
moving a repo-less dataset into a repo (`src/lib/repo-attach.ts`). The old
dataset push (`/api/datasets/:id/model/push`) is retired — it answers 410. There are no
ownership exceptions — dataset ownership is only half-built, so it grants no
publish rights. Full guide: `docs/api-tokens.md`.

## Who sees what: three layers, and only the first is a boundary

1. **Dataset access, with a level.** A role has a level per dataset — none,
   dashboards (`view`) or full (`query`) — set at Admin → Roles. On the dataset
   row: `roles` (every role with any access) and `view_only_roles` (the subset
   that may only view); a role in the first and not the second is full, so
   every grant from before levels existed is full. Someone's level is the best
   any of their roles gives them. **There is no public flag**: `datasets.is_public`
   was a second grant (full, for everyone signed in, over whatever the roles
   said), so a role at None went on opening the dataset. It is retired — nothing
   reads it, 0033 carried public datasets to `MALLOYYO_USER` at full, and "open
   to every member" is `openToMembers`, and `openToMember` / `openToMemberSql`
   wherever it decides what to show a PERSON (they must hold the members role;
   signed-out callers are told nothing at all). The column is
   still there only so the version live during a deploy can select it; drop it
   in the release after. `MALLOYYO_ADMIN` opens every dataset in full,
   decided INSIDE the predicate (`isAdminSql`), not by a flag callers pass.
   - `datasetAccessWhere(userId, need)` in `src/lib/roles.ts` is the rule.
     `visibleDatasetWhere` = may open; `queryableDatasetWhere` = may query.
   - `findByDatasetRef(userId, ref, need)` takes the level as a REQUIRED
     argument so no query surface can resolve at view level by omission.
     `findBySource`, `findByDatasetId` and the MCP host are always query-level.
   - `src/lib/role-access.ts` is the same rule as plain arithmetic, for the
     admin page to show its working (client-safe, no imports). The two must
     agree; `test/dashboard-audience.test.ts` holds them to it.
   - Row scoping inside a dataset is the model's (`$MALLOYYO_EMAIL`,
     `$MALLOYYO_ROLES`). `docs/roles-and-access.md`.
2. **Dashboard audience** — `src/lib/dashboards/audience.ts`. A dashboard is
   open to everyone on its dataset, or PRIVATE, and it is the same setting for
   a draft and a published dashboard: a draft's is
   `draft_dashboards.visibility` (new drafts are private; rows from before the
   column are `dataset`); a published one's is its entry in
   `datasets.dashboard_audience`, and until it has one, its tag
   (`# artifact { private }` → `manifest.private`). Private = admins + a
   draft's author + `dashboard_grants`, which are PER PERSON (never per role)
   and keyed by dashboard NAME (`draft-<slug>` for a draft) so they survive a
   republish. Writes are `src/lib/dashboards/sharing.ts`, behind
   `/api/dashboards/:ds/:name/sharing`; the UI is `DashboardShare` in the
   dataset nav. `recordPromotion` copies a draft's setting and people to the
   published name (and adds the author to a private one), so promotion never
   changes who can see a dashboard. It is ADMIN-ONLY, for anyone's draft: the
   target name is whatever the caller says, so the copy must not be available
   to someone who could not change that dashboard's audience directly.
3. **Impersonating** ("view as" in the code) — `src/lib/view-as.ts`. The UI
   and docs say Impersonate; the code says view-as. An admin sees the app as a
   non-admin user. The swap is in `getSessionUser()` (`src/lib/user.ts`), re-decided per
   request from a cookie that grants nothing by itself; `getRealSessionUser()`
   is for the start/stop route only. LOOK-ONLY: while viewing as someone,
   `getSession()` refuses every non-GET except the two POSTs that run a query —
   `/api/dashboards/run` and `/api/run` — using the method/path headers
   `src/proxy.ts` sets. A route on that list must itself write nothing as the
   target: `/api/run` reads `viewedBy` off `getSession()` and runs with
   `record: false` (no history row, no slug, no save). Bearer credentials are
   unaffected.

The dashboards level and private dashboards are **curation, not security** — a
dashboard's run route takes restricted Malloy, so anyone who can open one
dashboard can query its whole dataset. Don't write code (or docs) that treats
either as protecting data; separate data means separate datasets.

**Every dashboard read goes through `./meta`** (`getDashboard` and the list
functions), which is where the audience is enforced. `listDashboardsForModel`
and `listDraftsOnDataset` are the raw, unfiltered ones — pass their result
through `visibleDashboards` before showing it to anyone.

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
lockfile sync for the CLI's new @malloydata/malloy-filter dep — remember to
`npm install` after ANY dep change), deployed to production, and both
prod datasets refreshed (babynames v10 / auto_recalls v3 — six v2 dashboards
live). Verified first on the `dev-github-links` prod-fork branch
(local/CLAUDE.md).

Open questions for later: whitelisted charting libs for dashboards
(deliberately deferred); pre-existing dual-install tsc error at
`src/lib/mcp-host.ts:118` (npm root vs pnpm engine copy of @malloydata/malloy).
