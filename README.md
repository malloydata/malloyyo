# malloyyo

A **natural-language interface to any corpus of data, however complex** — accurate and consistent, served to any AI over MCP.

**Problem:** AI + document context + your analytical database = **inconsistent** results. Pointed at a raw database, an AI writes SQL from scratch — so the same question tomorrow yields a different query and different numbers, with wrong joins, invented columns, or fan-out double-counts that still *look* right.

**Solution:** AI + a [Malloy](https://malloydata.dev) **semantic layer** + your analytical database = **consistent** results. Measures, dimensions, and joins are defined once, correctly; the AI composes queries against the model instead of writing SQL, so numbers come back right by construction.

Malloyyo is the thin layer that serves that model:

- **Thin by design** — it sits between the AI and your data, nothing more.
- **Develop, then publish** — build the model locally and `malloyyo publish` it (or point Malloyyo at a GitHub repo).
- **Claude already knows Malloy** — the same way it knows Python — so authoring is incredibly fast and assisted.
- **Readable, full-featured queries** — Malloy is a complete query language (join, nest, aggregate, filter) that stays legible: you can read a query and see at a glance it's doing the right thing.
- **DuckDB built in** — query Parquet over plain HTTP (S3, GCS, any web server) with **no warehouse required**, or attach your own (BigQuery, Snowflake, MotherDuck, Databricks, …).
- **Tight control** — the AI can only query what's in the semantic model; nothing outside it is reachable.
- **A web interface, too** — every query is logged, so you can browse, edit, favorite, re-run, and share them in the browser (ltool), and hand any one off to "Explore further with Claude." Because Malloy renders a whole dashboard as a single query, one saved query can be a full report.
- **Deploy in minutes** — one-click to Vercel, or self-host with Docker.

Try [the demo server](https://malloyyo.vercel.app/ltool/main_7zfqmk7cv6) and "Explore further with Claude" — sign in with any Google account.

**Questions, or built something cool? We'd love to hear from you.** Come say hi on [Slack](https://join.slack.com/t/malloy-community/shared_invite/zt-2dvtske75-TJQfolRtZGXLS24RhTQ79g), and learn more about Malloy at [malloydata.dev](https://www.malloydata.dev) and in the [documentation](https://docs.malloydata.dev).

## How it works

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

**You don't have to know Malloy — or wire up the database by hand.** Install the [`malloyyo` CLI](packages/cli), register it with Claude, then ask Claude to do the rest: connect to your data, turn your existing SQL / dbt / Looker definitions into a Malloy model, and test it against real data before you publish. One tool for the whole loop.

**1. Install and register the local test window.**

```bash
npm install -g @malloydata/malloyyo        # one tool for the whole loop
claude mcp add malloyyo -- malloyyo mcp    # register it with Claude Code
```

`malloyyo mcp` runs a local stdio MCP server over the Malloy model in the current directory — the **same explore surface** (`list_sources`, `describe_source`, `query`) the hosted instance serves, so what you test locally is exactly what consumers get. It also registers the **`writing-malloy-with-mcp` skill** and `yo_help`, which teach Claude how to author Malloy, set up connections, and recover from compiler errors. (For Claude Desktop or another client, add the same `malloyyo mcp` command to its MCP config instead.)

**2. Build your model with Claude.** Start `claude` in your model directory and just describe what you have:

```
claude

> connect to my Postgres warehouse and build a Malloy model from these dbt sources
> add a "net revenue" measure and verify it against last quarter's numbers
```

Claude sets up the connection and writes the `.malloy` for you. It follows a compiler-in-the-loop discipline — validate against the compiler, run real queries through the test window, confirm the numbers — and you steer from the results. You rarely write Malloy by hand.

The connection lives in `malloy-config.json` at the model root, and Claude knows how to write it (`yo_help("connection-setup")`, or the [connection config docs](https://docs.malloydata.dev/documentation/setup/config)). Two things worth knowing:

- **DuckDB needs no config at all** — with no `malloy-config.json`, an in-memory `duckdb` connection just works, so Claude can read your local CSV / Parquet files immediately. Other backends (BigQuery, Postgres, MotherDuck, Snowflake, Databricks, MySQL, Trino, Presto) get a small `malloy-config.json` entry.
- **Secrets stay out of the committed file** — any value can be `{ "env": "VAR_NAME" }` (e.g. `ANALYTICAL_DATABASE_SECRET`), resolved from the environment when the connection opens. The same `malloy-config.json` ships to production on publish, so put anything environment-specific behind `{ "env": … }` and set that var locally and on the Malloyyo server.

**3. Publish.** Once the model queries cleanly, sign in once and push:

```bash
malloyyo login <your-instance>     # one-time browser sign-in
malloyyo publish <your-instance>   # bundle *.malloy + malloy-config.json and push
```

The server compiles and introspects the model and stores a new version; a compile failure rejects the push and leaves the live model unchanged. (Or push to GitHub and point Malloyyo at the repo.) See [`packages/cli/README.md`](packages/cli/README.md) for the CLI.

## Stack

- **Next.js 16** App Router
- **Your Analytical Database** —  Most SQL based analytical data storage and query engines
- **Neon Postgres** + **DrizzleORM** — metadata and auth state
- **Malloy** (`@malloydata/malloy` + `@malloydata/db-duckdb`) — semantic layer
- **NextAuth v5** + **Google OAuth** — user authentication
- **OAuth 2.1 provider** — MCP authorization for claude.ai, and login for the CLI
- **`malloyyo` CLI** (`packages/cli`) — publish models from a repo over an OAuth-authenticated push endpoint

## Deploy your own

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fmalloydata%2Fmalloyyo&env=DATABASE_URL,RUN_MIGRATIONS_ON_BOOT,AUTH_SECRET,AUTH_GOOGLE_ID,AUTH_GOOGLE_SECRET,APP_ADMIN_EMAILS,APP_BASE_URL,INSTANCE_NAME,INSTANCE_CODE&envDescription=Paste%20a%20Postgres%20DATABASE_URL%20and%20set%20RUN_MIGRATIONS_ON_BOOT%3D1.%20See%20the%20checklist%20for%20the%20rest.&envLink=https%3A%2F%2Fgithub.com%2Fmalloydata%2Fmalloyyo%23deploy-your-own&project-name=malloyyo&repository-name=malloyyo)

The button forks the repo into your GitHub and creates a Vercel project. The schema
**self-initializes on first boot** (`RUN_MIGRATIONS_ON_BOOT=1`), so you never run a
migration. The import screen prompts for these env vars:

1. **`DATABASE_URL`** — a Postgres connection string (you can get a free instance from
   [neon.tech](https://neon.tech)). **The build needs it, so paste one here.**
   *Prefer Vercel-managed storage? Finish the import with a temporary value, then add
   Postgres under the project's **Storage** tab — it overwrites `DATABASE_URL` — and
   redeploy.*
2. **`RUN_MIGRATIONS_ON_BOOT`** = `1` — create the schema on first boot.
3. **`AUTH_SECRET`** — `openssl rand -base64 32`.
4. **`APP_ADMIN_EMAILS`** — your email (admins add datasets / publish).
5. **`INSTANCE_NAME` / `INSTANCE_CODE`** — a display name + a short, unique slug (e.g. `gld`).
6. **`AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`** — for sign-in; you can leave these blank now
   and fill them after the first deploy (next step).
7. **`APP_BASE_URL`** — your deployment's URL, e.g. `https://<yourproject>.vercel.app`.

**Then enable Google sign-in:** create a Google OAuth app (Google Cloud Console →
Credentials → Web application), set its authorized redirect URI to
`https://<your-domain>/api/auth/callback/google`, put the client ID/secret + your
`APP_BASE_URL` into the project's env vars, and redeploy.

After that, sign in with the admin email and add a dataset.

> Your model's `malloy-config.json` references your analytical database's secret from an
> env var (e.g. `ANALYTICAL_DATABASE_SECRET` — see [Developing Malloy models](#developing-malloy-models)). Set that var on the project so the server can connect. `GITHUB_TOKEN` is optional (private-repo model pulls).

## Running locally

Copy `.env.local.example` to `local/<instance>` and fill in the blanks:

```bash
DATABASE_URL=postgresql://...          # Neon (or any Postgres)
APP_BASE_URL=http://localhost:3000
APP_ADMIN_EMAILS=you@example.com
AUTH_SECRET=...                        # openssl rand -base64 32
AUTH_GOOGLE_ID=...                     # Google OAuth client ID
AUTH_GOOGLE_SECRET=...                 # Google OAuth client secret
# GITHUB_TOKEN=github_pat_...          # Optional; needed for private repos
```

**Google sign-in** needs a Google OAuth app — Google Cloud Console → APIs & Services →
Credentials → **Create OAuth client ID** → type **Web application**. Put its client
ID/secret into `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`, and add this **Authorized redirect
URI**:

```
http://localhost:3000/api/auth/callback/google
```

(Miss this and Google rejects sign-in with `redirect_uri_mismatch`.)

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
