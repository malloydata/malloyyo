# Upgrading

Steps an operator runs when pulling a new version of Malloyyo. Newest first.

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
