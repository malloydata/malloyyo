# Upgrading

Steps an operator runs when pulling a new version of Malloyyo. Newest first.

## History + saved_queries redesign (2026-07-01)

Flattens the `conversations` / `inquiries` / `tool_calls` / `queries` tables into
two:

- **`history`** — one row per MCP tool call **and** ltool run, grouped into
  30-minute `(user, dataset)` sessions with a `sequence`. Records the
  `question`, `user_agent`, `author_model`, `executed` (validate vs run),
  `error`, and a per-run share `slug`. Validate-only and failed attempts are kept
  here for syntax-error analytics. Designed to be **trimmable**.
- **`saved_queries`** — durable, favoritable copies (question + Malloy + SQL +
  slug), promoted from a run when it is favorited or saved from ltool.
  `favorites` now points here, so favorites survive history trimming.

`question` is now **required on every `query` call** — validate (`execute:false`)
as well as run. `author_model` comes from the optional **`x-author-model`**
request header (ground truth when a client / test harness sets it) or defaults to
`assistant`; ltool runs resolve `human` vs an inherited author server-side.

> ⚠️ **This is a destructive migration**, unlike the additive ones below. It
> DROPS `conversations`, `inquiries`, `tool_calls`, `queries`, and the old
> `favorites`. **Share slugs minted before this release stop resolving.** The
> dropped tables are copied to `*_bak` first, and favorited queries are restored
> into `saved_queries` by the backport step.

### Run the migrations (once, in order)

Both are idempotent — safe to re-run; the backport is a clean no-op on a fresh
install:

```bash
psql "$DATABASE_URL" -f drizzle/manual/0003_history_redesign.sql
psql "$DATABASE_URL" -f drizzle/manual/0004_backport_favorites.sql
```

- `0003` backs up the old tables to `*_bak`, then builds `history` +
  `saved_queries` + the re-pointed `favorites`.
- `0004` restores favorited queries from the backups into `saved_queries` (+
  `favorites`). History itself is disposable and is **not** backported.

Once you've verified the new schema, drop the `*_bak` tables to reclaim space.

No new env vars. `x-author-model` is an **optional** request header for model
attribution — clients that don't send it (e.g. claude.ai) record `assistant`.

### After deploy

- The tool surface is unchanged (`query`, `list_sources`, `describe_source`,
  `open_share_link`), so **no reconnect is required** — but note that `query`
  now rejects any call (validate or run) that omits `question`.
- If you use the internal **malloyyo_analytics** model, re-publish it: its
  sources moved from `inquiries` / `tool_calls` to `history` / `saved_queries`.

## malloyyo CLI model publishing (2026-06-11)

Adds the `malloyyo` CLI publish path: admins push a directory of Malloy files to a
dataset, the server compiles + introspects it, and stores a new model version with git
provenance. Adds columns for that provenance and for last-publish status. The existing
GitHub *pull* path is unchanged and keeps working.

### Run the schema migration (once)

Idempotent — safe to re-run:

```bash
psql "$DATABASE_URL" -f drizzle/manual/0002_model_publish.sql
```

What it does (all `ADD COLUMN IF NOT EXISTS`):
- `malloy_models.git_repo / git_branch / git_sha / git_dirty` — provenance of a pushed
  model version
- `datasets.last_publish_at / _sha / _branch / _error` — the last publish attempt,
  success or failure (failures are recorded here but never become a servable model version)

No new env vars. Publishing is **admin-only** and authenticates with an OAuth bearer
token — the same tokens the MCP endpoint issues; an admin gets one with `malloyyo login`.

### After deploy

Nothing required. An admin can `malloyyo login <url>` and then `malloyyo publish` to a
dataset (datasets must already exist — publish never auto-creates one). See
`packages/cli/README.md` for the CLI.

## Tool surface redesign (2026-06-08)

Slims the MCP tool surface from 6 tools to 4 so the most important tool ranks
reliably in clients that only fetch a handful of a connector's tools up front.

**No *new* database step for this release.** The schema is unchanged and this
release adds no migration — tool-call history is preserved by matching old *and*
new log labels in code, not by rewriting rows.

> If you are upgrading from **before** the ltool release (2026-06-07) you must
> still run that release's `0001_ltool_slugs.sql` migration (see below) — it is
> cumulative, not replaced by this one. Already on the ltool release? Nothing to
> run; just deploy.

### What changed

- **4 tools now:** `query`, `list_sources`, `describe_source`, `open_share_link`.
- `run_query` → **`query`**. It also absorbs compiling: pass `execute:false` to
  get just the generated SQL (replaces the standalone `compile_query` tool).
- `describe_query` → **`open_share_link`**.
- `start_conversation` is **removed** — `query` auto-creates the conversation;
  pass an optional `context` on the first `query` to record the session goal.
- Behavioral guidance (the "Query summary" rule, `ltool_url` formatting, etc.)
  now ships once in the MCP `initialize` **server instructions**, not in every
  tool description.

### Backward compatibility

Unlike the previous rename, the **old tool names still work as aliases**
(`run_query`, `compile_query`, `describe_query`, `start_conversation`), so saved
prompts and automations keep functioning. Update them at your leisure.

### After deploy

- In claude.ai, **disconnect and reconnect** (or refresh the connector) so the
  client re-fetches the new tool list and server instructions.
- Update any docs/prompts that hard-code `run_query` / `describe_query`.

## ltool + instance identity (2026-06-07)

This release renames the MCP tools, adds shareable query links (`/ltool/<slug>`),
and introduces per-instance identity so multiple Malloyyo deployments can be
connected to the same Claude client without confusion.

### 1. Set instance identity env vars

Add two env vars to this deployment (Vercel project settings, or your env file):

| Var             | What it is                                              | Example         |
| --------------- | ------------------------------------------------------- | --------------- |
| `INSTANCE_NAME` | Display name; shown in the UI + every MCP tool name tag | `Guild Malloy`  |
| `INSTANCE_CODE` | Short slug prefix (`a-z0-9`); prefixes share slugs      | `gld`           |

Pick an `INSTANCE_CODE` that is **distinct from every other instance** you run
(e.g. `main`, `stg`, `gld`). Defaults are `Malloyyo` / `main` if unset.

### 2. Run the data migration (once)

The schema column is created automatically by `drizzle-kit push`, but the data
backfill ships as a hand-written, idempotent SQL file. Run it once against this
deployment's database, with `:code` set to **your** `INSTANCE_CODE`:

```bash
psql "$DATABASE_URL" -v code=gld -f drizzle/manual/0001_ltool_slugs.sql
```

(Pass your `INSTANCE_CODE` via `-v code=...`; it defaults to `main` if omitted.)

What it does (all idempotent — safe to re-run):
- adds `inquiries.slug` and backfills existing rows with `<code>_<random>`
- adds a unique index on `inquiries.slug`
- renames historical `tool_calls.tool_name` values to the new tool names so
  existing query history stays visible

If you use `drizzle-kit push` for schema, run that too (it will no-op on the
slug column if the SQL above already added it):

```bash
npx drizzle-kit push
```

### 3. Deploy the new build

Deploy as usual. After deploy:

- The query runner moves from `/history` to `/ltool`.
- MCP tools are renamed: `describe_semantic_model → describe_source`,
  `compile_analytical_query → compile_query`,
  `run_analytical_query → run_query`, plus a new `describe_query`.
- In claude.ai, **rename the connection to match `INSTANCE_NAME`** so the
  human-facing label lines up with the self-identifying tool tags.

> Note: old MCP tool names are **not** kept as aliases. Any saved prompts or
> automations referencing the old names must be updated.
