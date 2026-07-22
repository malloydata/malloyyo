# Concepts

The vocabulary the rest of the guides assume. Skim it once; come back when a
word doesn't land.

---

## The model

### Semantic model

A directory of `.malloy` files describing your data: what the tables are, what
they mean, how they join, and what's worth measuring. It is the contract
between your data and everyone who asks it questions.

The model is **code in a git repo** — you author it, review it, and version it
like anything else. It is not generated for you and not stored in a UI.

### `index.malloy`

The entry file, at the repo root. It imports whatever it needs and **exports the
public surface** — the sources consumers are allowed to query:

```malloy
import "users_base.malloy"
import "orders_base.malloy"

source: users is users_base extend {
  join_many: orders is orders_base on id = orders.user_id
}

export { users }
```

Without an `export` statement everything you define is public. Add one and the
surface becomes explicit: the listed names are what consumers discover and can
reach by bare name. Base sources and staging intermediates stay out of the way.

**Export is curation, not secrecy.** It decides the catalog — what
`list_sources` shows and what resolves without qualification. It is not an
access boundary: a caller that names the model explicitly can still reach an
unexported source. Don't rely on it to hide anything sensitive; use a dataset's
visibility, or don't put the data in the model. See
[Governance](governance.md).

`index.malloy` is the one thing the publish and MCP paths look for.

### Source

A queryable thing — roughly a table plus everything you've defined on top of it.
A source has:

- **dimensions** — the columns, and expressions computed per row
- **measures** — aggregates (`count()`, `revenue.sum()`), defined once so
  everyone gets the same number
- **views** — saved queries the author considers worth having by name
- **joins** — the other sources it reaches, and whether they fan out

Sources are the unit of addressing: agents list sources, describe a source, then
query that source.

### Given

A named, typed input to a query — Malloyyo's filters are all givens. They're
declared once in the model and applied per query with `~`:

```malloy
given:
  # label="Brand"
  BRAND :: filter<string> is f''
```

A given is typed `filter<T>`, which means it holds a whole *filter expression*,
not a single value: `'CA'`, `'CA, NY'`, `-'TX'`, `'[1980 to 1990]'`. Empty
(`f''`) naturally means **all**.

The `#` tags on the declaration are what the dashboard runtime reads to draw a
control — the label, the widget, where to get suggestions. Nothing is redeclared
in JavaScript.

### Artifact / dashboard

**One dashboard, one file**, in `dashboards/`. The file imports what it needs,
declares its query, and tags it. The tag *is* the declaration — there is no
manifest:

```malloy
// dashboards/overview.malloy
##! experimental.givens
import "../ecommerce.malloy"

#" Business health at a glance — sales, margin, orders.
# artifact { title="Business Overview" } dashboard {columns=6}
query: overview is order_items -> { ... }
```

**The filename is the name** — its URL slug, its `# drill { to= }` target, and
the basename of its optional component all agree, so there's nothing to keep in
sync. Don't set `name=`.

Dashboards are **not** declared or exported in `index.malloy`; discovery globs
`dashboards/*.malloy`. A file in there with no `# artifact` tag is treated as a
shared include, not a dashboard.

Most dashboards are **tag-only** — no JavaScript at all, drawn by the Malloy
renderer. One that needs custom drawing adds a flat sibling
`dashboards/<name>.jsx` (or `.tsx`).

> `# artifact` is Malloyyo's declaration; `# dashboard` is Malloy's *renderer*
> tag. They're partners, often on the same line, and they are not the same
> thing.

### `malloy-config.json`

Sits at the model root and describes the connection to your data. Committed —
which is why any value can be an env-var reference instead of a secret:

```jsonc
{
  "connections": {
    "warehouse": { "type": "postgres", "password": { "env": "PG_PASSWORD" } }
  }
}
```

DuckDB needs no config at all; with no file, an in-memory `duckdb` connection
just works, so an agent can read your local CSV and Parquet files immediately.

The same file ships to the server on publish, so anything environment-specific
belongs behind `{ "env": … }` and gets set on both sides.

---

## The two surfaces

The CLI serves the same MCP engine in two modes, and which one an agent is
connected to decides what it can do. This distinction runs through everything.

| | **author** | **explore** |
|---|---|---|
| command | `cd repo && claude` (after `init`), or `malloyyo author` | `malloyyo test` |
| under the hood | `malloyyo mcp --develop` | `malloyyo mcp --explore` |
| sees | any `.malloy` file in the project, on disk | `index.malloy` only, as published |
| can | compile, prettify, query, iterate | list, describe, query |
| Malloy accepted | anything | restricted (see [Governance](governance.md)) |
| for | building the model | rehearsing what consumers get |

The explore surface is the **same code** the hosted `/mcp` endpoint runs. That's
what makes `malloyyo test` a faithful rehearsal rather than an approximation.

Author mode's server is named `malloyyo_author`, so the mode is visible in every
tool call (`mcp__malloyyo_author__…`).

---

## The server

### Instance

One deployment of Malloyyo. It has a display name and a short code:

- **`INSTANCE_NAME`** — shown in the UI, in the MCP `serverInfo`, and prefixed
  `[Name]` onto every tool description, so an agent connected to several
  instances routes to the right one.
- **`INSTANCE_CODE`** — a short slug prefix (`main`, `stg`, `gld`), **unique per
  deployment**. Share links are `<code>_<id>`, so a link minted on one instance
  is recognized and rejected — with a pointer to the right one — if handed to
  another.

### Dataset

The addressable unit on a server: a named home for one model. Its **name** is
snake_case and unique, and it's what agents and URLs refer to.

Datasets are created by an **admin** and don't appear by themselves — publishing
into a dataset that doesn't exist fails. Each is either public (everyone signed
in can see it) or private to its owner.

### Model version

A dataset has many versions; **the latest is the live one**. Each version stores
`index.malloy`, every other model file, the dashboards, and the git provenance
it came from — repo, branch, sha, and whether the tree was dirty.

Only models that compiled are ever stored, so *latest = live = valid*. A failed
publish is recorded on the dataset and leaves the live model untouched.

Two ways a version gets created:

- **push** — `malloyyo publish` from your working tree (the usual path)
- **pull** — the server fetches from a configured GitHub repo, optionally on a
  push webhook

### ltool

The web query surface. Browse the history of questions asked, open one, edit the
Malloy, re-run it, star it, share it. Because Malloy renders a whole dashboard
as a single query, one saved query can be a complete report.

### History, saved queries, favorites

- **History** is the activity log: every MCP tool call and every ltool run,
  including validate-only and failed attempts. Disposable by design.
- **Saving or starring promotes** a history row into a durable saved query,
  carrying its share slug — so links you've handed out keep working even after
  history is trimmed.
- A dataset's **questions page** is the accumulated record: every question
  answered against it, by agents and humans alike, deduped with ask counts.

### Share link

A successful run mints `<INSTANCE_CODE>_<id>` and a URL at `/ltool/<slug>`.
Agents get it back in the tool result and are told to include it; humans get a
Share button. Handing that link back to an agent — the *"Explore further with
Claude"* button — reopens the exact query so the conversation continues from a
real result.

### Admin

Admins create datasets, publish models, toggle visibility, and edit instance
settings. Admin comes from the `APP_ADMIN_EMAILS` environment variable (or a
direct database edit) — there is no in-app way to grant it.

Everyone else who can sign in can query, favorite, share, and use dashboards and
MCP.

---

## How the pieces relate

```
  repo (git)                         server (instance)
  ├── malloy-config.json  ──┐
  ├── index.malloy          ├─ publish ─►  dataset ─► model version (live)
  ├── *.malloy              │                            ├─ sources  ─► /mcp
  └── dashboards/*.malloy ──┘                            └─ artifacts ─► web
```

One repo → one dataset. One instance → many datasets. One model version → the
sources agents query and the dashboards humans open.

---

**Next:** [Authoring a model](authoring.md)
