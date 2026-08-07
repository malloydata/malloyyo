---
name: malloyyo-data-site
description: Turn a public data URL into a browsable, interactive dashboard site hosted on GitHub Pages, using Malloy (malloyyo). Use when someone points at data on the web (CSV/TSV/Parquet/JSON at an https URL) and wants a public web interface to explore it — scaffold the repo with `malloyyo init`, transform the data into parquet under docs/, write the Malloy model + dashboards, preview with `malloyyo dashboard dev`, build with `malloyyo dashboard bundle`, and publish on GitHub Pages. Worked examples: malloydata/malloyyo-babynames (base) and malloydata/malloyyo-imdb (adds a transform + weekly auto-update).
---

# Build a public data site from a web data pointer

Goal: given one or more **public data URLs**, produce a **GitHub Pages site** of
interactive Malloy dashboards that anyone can open in a browser. The data ends
up as parquet in `docs/`; the dashboards are static HTML that query it
client-side with DuckDB-WASM — so there is no server, no database to run.

Two reference repos — read them, they are the ground truth for structure:

- **`malloydata/malloyyo-babynames`** — the clean base pattern (one model file,
  a few dashboards, `docs/`). Data is static.
- **`malloydata/malloyyo-imdb`** — the same, plus a `transform.malloy` that
  cleans raw source files into parquet, plus a **weekly auto-refresh** (that
  part is the separate `malloyyo-auto-update` skill).

Fetch either with `gh api repos/<repo>/git/trees/HEAD?recursive=1` and read the
files you need. Match their layout rather than inventing your own.

## The shape of a finished repo

```
malloy-config.json     connection(s): duckdb (local), optionally md/gs mirrors
index.malloy           the EXPORT SURFACE — only what this file exports is live
<model>.malloy         sources, measures, joins, givens (parameters)
storage.malloy         sources point at the parquet — docs-local OR an https URL
  (or gs.malloy / md.malloy)   same source names, swappable hosting (step 3)
dashboards/*.malloy    the query behind each dashboard
dashboards/*.jsx       the dashboard layout (grid of charts/tables)
docs/                  PUBLISHED SITE — bundled HTML (+ the *.parquet if docs-local)
  *.parquet            the data, when hosted docs-local (committed; served by Pages)
  *.html .nojekyll     written by `malloyyo dashboard bundle`
.mcp.json              written by `malloyyo init` (author-mode Claude)
```

## Prerequisites (install once)

```bash
npm install -g @malloydata/malloyyo      # the `malloyyo` command
```

That's the whole toolchain for the common case. `malloyyo` has **DuckDB built
in** — `malloyyo sql` runs SQL (read a URL, `COPY` to parquet) through it, so you
do **not** need a standalone `duckdb` CLI.

Add `@malloydata/cli` (`malloy-cli`) **only** if you do a heavier transform with
Malloy `#@ persist` (see Path B in `reference/data-to-parquet.md`):

```bash
npm install -g @malloydata/cli           # only for #@ persist transforms
```

## Recipe

Work top to bottom. After each step, prove it before moving on.

### 1. Scaffold

```bash
mkdir my-site && cd my-site && git init
malloyyo init            # writes .mcp.json (author-mode Claude) + index.malloy stub
```

Create `malloy-config.json` with a local DuckDB connection (this is what reads
the parquet):

```json
{ "connections": { "duckdb": { "is": "duckdb" } } }
```

### 2. Get the web data into `docs/*.parquet`

This is the one dataset-specific step. Two paths — pick the simpler one that
works. Full detail and copy-paste commands: **`reference/data-to-parquet.md`**.

- **Direct** (default): `malloyyo sql` reads the URL and writes parquet in one
  shot, through the embedded DuckDB:
  ```bash
  echo "COPY (FROM read_csv_auto('https://…/thing.csv')) TO 'docs/thing.parquet'" | malloyyo sql
  ```
  Use when the web data is already close to what you want to show.
- **Transform** (when you need to clean / join / rank / reshape): write a
  `transform.malloy` with `#@ persist` sources and build it with `malloy-cli`,
  then export the tables to `docs/*.parquet`. This is the `malloyyo-imdb`
  pattern.

Verify: `malloyyo sql -e "DESCRIBE SELECT * FROM 'docs/thing.parquet'"` and a
`SELECT count(*)`.

### 3. Write the model

A storage file — one source per parquet file — that the rest of the model builds
on. **Where the parquet lives is a choice** (the two examples differ here):

- **docs-local** (the `malloyyo-imdb` way) — parquet committed in `docs/`,
  served same-origin by Pages. Self-contained; git carries the data. Address it
  by project-relative path so the same spelling works locally and published:
  ```malloy
  // storage.malloy
  source: thing_table is duckdb.table('docs/thing.parquet') extend {}
  ```
- **External URL** (the `malloyyo-babynames` way — it uses `import "gs.malloy"`)
  — parquet hosted on GCS / a CDN / any https URL; `docs/` holds only the HTML,
  so git stays small. DuckDB-WASM fetches the URL at runtime:
  ```malloy
  // gs.malloy
  source: thing_table is duckdb.table('https://storage.googleapis.com/…/thing.parquet') extend {}
  ```

Keep the **source names identical** across storage files (as babynames does with
`gs.malloy` / `md.malloy`) so switching hosting is a one-line import change in
the model. Start docs-local (simplest); move to a URL if git growth bites.

`<model>.malloy` — build real sources on top: primary keys, measures, joins,
and **givens** (the parameters that become the dashboard's filter controls).
`index.malloy` — re-export exactly the sources/queries/givens the dashboards
use. **Only what `index.malloy` exports is visible** to dashboards, `dashboard
dev`, and the hosted app.

Give each exported source a `#"` doc string. It's what `list_sources` shows the
hosted app and any MCP client, and it's the only place to record the things a
consumer can't infer — which source answers which question, and any measure
whose meaning is subtle.

For Malloy modeling and givens specifics, lean on the author MCP rather than
guessing: the repo's `.mcp.json` wires `mcp__malloyyo_author__*`. Call
`mcp__malloyyo_author__compile` to check files and
`mcp__malloyyo_author__yo_help` for topics (`develop/working-with-models`).

Three shapes that compile, pass `lint`, and still produce a dashboard that looks
right and isn't:

- **A stage-level `where:` zeroes measures that carry their own filters.**
  `count() { where: status = 'Sold' }` needs the sold rows to reach it; a
  `where: in_cellar` on the stage removes them first and the measure reads 0
  everywhere. Constrain the output with `having:` instead.
- **Grouping finer than the fact scatters the counts.** Group by an attribute
  that only applies to some rows and the measures over the others split across
  groups and read near-zero. Pick the grain the question is asked at; if you
  need both, group at the coarser one and `nest:` the finer.
- **Detail tables default to raw field names and bare numbers.** `exit_date` and
  `829.57`, and a null renders as `∅`. Tag them — `# label="Opened"`,
  `# label="Paid" currency` — and `coalesce(field, '')` where empty is
  meaningful rather than missing.

Aggregate locality is NOT one of these: Malloy's symmetric aggregates keep
measures honest through a `join_many` fan-out, and it warns (or errors) rather
than silently answering when an `avg`/`sum` crosses a join without explicit
locality. `notes.rating.avg()` already averages at the notes grain; ask for
`source.avg(notes.rating)` only when you want the fan-out-weighted number. See
`yo_help language/aggregate-locality-symmetric-aggregates`.

### 4. Author dashboards and preview live

Each dashboard is **one self-contained `dashboards/<name>.malloy`** — the query,
its filtering, and the tags that lay it out. The filename is the dashboard's
name and URL slug.

**A `.jsx` is OPTIONAL and most dashboards don't need one.** The default form —
an inline query tagged `# artifact` + `# dashboard { columns=6 }` — renders KPI
tiles and a card grid with no React at all. Reach for a sibling
`dashboards/<name>.jsx` only when you want bespoke layout or presentation the
tags can't express (a hand-built card, a picker, a Vega chart).

Author with the `malloyyo_author` MCP and its `yo_help` topics — **read these,
don't guess the API**: `dashboards/authoring` (the dashboard file),
`dashboards/grid-layout` (colspans), `dashboards/charts` (chart tags and their
channel rules), `dashboards/givens-and-controls` (filters),
`dashboards/custom-components` and `dashboards/vega-charts` (only if you add a
`.jsx`).

Preview in a browser with live reload:

```bash
malloyyo dashboard dev          # serves at http://localhost:4173
```

Two things about `dashboard dev` worth knowing:

- It runs the queries **server-side**, through the same local DuckDB the CLI
  uses — the browser only renders results. So it works without DuckDB-WASM or
  its CDN extensions, and it is the only way to see a custom component render
  against real data short of publishing.
- It holds **one long-lived connection set with a warm schema cache** (a
  deliberate tradeoff — refetching schemas per compile reads like a hang on a
  warehouse). The file watcher hot-reloads your `.malloy` edits and re-discovers
  `# artifact` tags, but nothing invalidates that cache, so a change to the
  DATA's shape — a new column in a parquet — needs a restart. The tell is
  `'<column>' is not defined` in the browser while the CLI and `lint` are green.

Iterate here until the dashboards look right. **Look at every dashboard before
you call it done**: `malloyyo lint` compiles the dashboards against the model but
does not render them, so it cannot see a chart that throws at render time, a
component whose CSS resolved to nothing, or a column of raw field names.
`malloyyo test` previews what the hosted claude.ai app would see.

### 5. Build the static site

```bash
malloyyo dashboard bundle --out docs
# optional: add analytics + a title
malloyyo dashboard bundle --out docs --title "My Site" --analytics G-XXXXXXXXXX
```

`bundle` writes the HTML, `.nojekyll`, and assets into `docs/`, next to the
parquet from step 2. The pages fetch `./*.parquet` relative to the site root, so
the data must already be in `docs/` — always run the data step before bundling.

### 6. Publish on GitHub Pages

Commit `docs/` and turn on Pages (Settings → Pages → Deploy from a branch →
`main` / `docs`). Full steps + gotchas: **`reference/publish-to-github-pages.md`**.

### 7. (Optional) Keep it fresh automatically

If the data comes from a URL that updates over time and you want the site to
track it, add a weekly GitHub Actions refresh — see the **`malloyyo-auto-update`**
skill (worked example: `malloydata/malloyyo-imdb`).

## Done when

- `malloyyo sql -e "SELECT count(*) FROM 'docs/<file>.parquet'"` returns real rows
- `malloyyo lint` passes
- **you have LOOKED at every dashboard** in `malloyyo dashboard dev` — each one
  renders with no console errors, every tile has data, and the labels read like
  English rather than column names. `lint` passing is not this; a dashboard can
  compile and still throw at render time.
- `docs/` has the bundled `*.html` + `.nojekyll` alongside the parquet
- the Pages URL loads and the dashboards populate (data fetch succeeds)
