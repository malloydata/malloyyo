# Developing Malloy models

Build a semantic model with Claude, then publish it to a Malloyyo server.


**You don't have to know Malloy — or wire up the database by hand.** Install the [`malloyyo` CLI](../packages/cli), register it with Claude, then ask Claude to do the rest: connect to your data, turn your existing SQL / dbt / Looker definitions into a Malloy model, and test it against real data before you publish. One tool for the whole loop.

> **Want none of this on your laptop?** Open your model repo in a **GitHub Codespace**
> on the prebuilt [Malloyyo dev container](devcontainer.md) — Claude Code, the Malloy
> and Claude VS Code extensions, the `malloyyo` CLI, Node, Playwright and `gcloud`/`bq` are
> already in the image. `malloyyo init` writes the one-line
> `.devcontainer/devcontainer.json` that opts a repo in, and its codespace starts
> in seconds.

**1. Install and set up your model repo.**

```bash
npm install -g @malloydata/malloyyo   # one tool for the whole loop
cd my-model-repo
malloyyo init                         # write .mcp.json + scaffold index.malloy
```

`malloyyo init` sets the repo up so that **`cd my-model-repo && claude` opens in author mode** — connected to `malloyyo mcp --develop`, whose tools (`compile`, `compile_file`, `prettify`, `query`, `yo_help`) let Claude build the model *and* ask data questions of it. The server is named **`malloyyo_author`**, so the mode shows in every tool call (`mcp__malloyyo_author__…`) — no confusion with the core `malloy-cli`. `init` also scaffolds an `index.malloy` (the entry model the dashboard/publish tooling needs) if you don't have one.

Two modes, chosen at launch, kept separate:

| command | surface | for |
| --- | --- | --- |
| `cd repo && claude` (after `init`) | **author** (`--develop`) | build the model — compile/edit/query, any `.malloy` file |
| `malloyyo test` | **explore** (`--explore`) | preview **exactly** what claude.ai web will see (`list_sources`/`describe_source`/`query`, `index.malloy` only) |

`malloyyo test` launches Claude wired to *only* the explore surface, so it's a faithful web dress rehearsal. (`malloyyo author` is the explicit, single-surface counterpart to the `cd && claude` default.) Full authoring guidance — dashboards, givens/controls, grid layout, Vega charts — is reachable from either mode via `yo_help` (topics under `dashboards/*`, `develop/*`). For Claude Desktop or another client, add `malloyyo mcp --develop` (author) or `malloyyo mcp --explore` (test) to its MCP config.

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

The server compiles and introspects the model and stores a new version; a compile failure rejects the push and leaves the live model unchanged. (Or push to GitHub and point Malloyyo at the repo.) See [`packages/cli/README.md`](../packages/cli/README.md) for the CLI.

## Publishing a dataset


Develop your model in a repo with an `index.malloy` at its root, then **publish it with the [`malloyyo` CLI](../packages/cli)**.

First tell the repo where it publishes to. Nothing writes this for you — `malloy-config.json` is yours, and the CLI only ever reads it — so add a `malloyyo` block beside your connections:

```json
{
  "connections": { "warehouse": { "is": "postgres", "host": "…" } },
  "malloyyo": {
    "targets": { "prod": { "url": "https://your-instance.example.com", "dataset": "orders" } }
  }
}
```

Then:

```bash
malloyyo login              # one-time browser sign-in
malloyyo publish            # bundle *.malloy + malloy-config.json and push
```

Both take a target name (`malloyyo publish prod`) when the repo defines more than one.

**A repo with a `datasets/` directory** (one dataset per directory) publishes all of them as
one unit, so its target names the **repo** — its GitHub `owner/name` — instead of a dataset:

```json
"malloyyo": {
  "targets": { "prod": { "url": "https://your-instance.example.com", "repo": "acme/models" } }
}
```

`malloyyo publish` then needs no flags; `--repo owner/name` overrides the target's `repo`, the
way `--dataset` overrides its `dataset`. A target names one or the other, never both, and the
CLI refuses the one that doesn't fit the repo's layout rather than ignoring it.

The dataset must exist first — create it in the UI, or add `--create-dataset` to the first
publish (it creates a private dataset, and only once the model compiles).

**In CI there is no browser to sign in with**, so mint an API token instead — in the UI at
`/settings/tokens` (any member can, for themselves) — and hand it over in the environment:

```bash
export MALLOYYO_TOKEN=myo_…    # instead of `malloyyo login`
malloyyo publish
```

A token is shown once, carries the scopes you tick (`publish`, `mcp`), expires when you say
so or never, and is revocable from the same page — effective on the very next request.
See **[API tokens](api-tokens.md)** for the CI recipe and the rest.

The CLI records the git commit it published from; Malloyyo compiles and introspects the model and stores a new version. If it doesn't compile, the push is rejected and the live model is left unchanged.

Alternatively, **point Malloyyo at a GitHub repo** and it pulls `index.malloy` (and any
imports) plus dashboard artifacts under `dashboards/` directly — a webhook endpoint
(`/api/datasets/<id>/webhook/github`) refreshes them on every push.
