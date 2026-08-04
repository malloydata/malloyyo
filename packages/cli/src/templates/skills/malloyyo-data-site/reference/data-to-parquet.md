# Getting web data into `docs/*.parquet`

The site queries parquet files (in `docs/`, or at an https URL — see the model
step). This is how you turn a public data URL into that parquet. Pick the
simplest path that produces clean data.

`malloyyo sql` runs SQL through malloyyo's **embedded DuckDB** — no standalone
`duckdb` binary. It takes SQL from `-e`, `-f <file>`, or stdin, and runs against
a connection from `malloy-config.json` (default `duckdb`).

## Path A — Direct (default)

One command reads the URL and writes parquet. Best when the web data is already
close to what you want to display.

```bash
# CSV / TSV
echo "COPY (SELECT * FROM read_csv_auto('https://example.com/data.csv'))
      TO 'docs/data.parquet' (FORMAT parquet)" | malloyyo sql

# TSV, gzipped, tab-delimited, header row (IMDb-style)
echo "COPY (SELECT * FROM read_csv_auto('https://example.com/data.tsv.gz',
            delim='\t', header=true, all_varchar=true))
      TO 'docs/data.parquet' (FORMAT parquet)" | malloyyo sql

# JSON / NDJSON
echo "COPY (SELECT * FROM read_json_auto('https://example.com/data.json'))
      TO 'docs/data.parquet' (FORMAT parquet)" | malloyyo sql

# Already parquet on the web — just fetch it
curl -fsSL -o docs/data.parquet 'https://example.com/data.parquet'
```

For anything longer than a line or two, put the SQL in a file and run it with
`-f`, so it's re-runnable and diffable:

```bash
malloyyo sql -f scripts/build.sql        # a file of ;-separated statements
```

Notes:
- DuckDB autoloads `httpfs` for `https://` reads.
- Keep only the columns/rows the dashboards need — `SELECT` the columns and add a
  `WHERE` to drop noise. Smaller parquet = faster page loads.
- Cast types here if the source is all-strings: `col::INT`, `col::DOUBLE`, etc.

## Path B — Transform with Malloy (when you need to reshape)

Use when the data needs cleaning, joining across files, ranking, or nesting —
the `malloydata/malloyyo-imdb` case. You write the transform once in Malloy;
`malloy-cli build` materializes it; you export the tables to parquet. This path
also needs `@malloydata/cli` (`npm install -g @malloydata/cli`).

**1. A build connection** — `malloy-build.json` (a DuckDB db just for building):

```json
{ "connections": { "build": { "is": "duckdb", "databasePath": "data/build.duckdb" } } }
```

**2. `transform.malloy`** — read the raw source(s) through the `build`
connection and mark each output source with `#@ persist name="…"`:

```malloy
##! experimental.persistence experimental.virtual_source

source: raw is build.sql("""
  SELECT * FROM read_csv_auto('data/raw.csv.gz', delim='\t', all_varchar=true, header=true)
""")

#@ persist name="thing"
source: thing_base is raw -> {
  where: some_count::number > 100
  select: id, name, value is value::number
  calculate: rank is rank() { order_by: value::number desc }
}
```

Download the raw files first (a `data/get.sh` that `wget`s the URLs into `data/`,
gitignored). Gitignore `data/`, `data/*.duckdb`, and `MANIFESTS/`.

**3. Build, then export the persisted tables to `docs/`** — the export still
goes through `malloyyo sql` (no standalone duckdb needed):

```bash
rm -f data/build.duckdb
malloy-cli -c malloy-build.json build transform.malloy   # -> tables in build.duckdb
echo "ATTACH 'data/build.duckdb' AS b (READ_ONLY);
      COPY b.thing TO 'docs/thing.parquet' (FORMAT parquet)" | malloyyo sql
```

The persist `name=` is the table name inside `build.duckdb`; the `COPY` names the
served file (they can differ — e.g. `thing` → `docs/mysite_thing.parquet`).

Wrap steps 1–3 in a single `scripts/build_data.sh` so it is one command, by hand
and in CI. That's exactly what `malloyyo-auto-update` automates weekly.

## Either way, verify

```bash
malloyyo sql -e "DESCRIBE SELECT * FROM 'docs/thing.parquet'"
malloyyo sql -e "SELECT count(*) FROM 'docs/thing.parquet'"
```

Then point a storage source at it (docs-local shown; an https URL works too —
see the model step in SKILL.md):

```malloy
source: thing_table is duckdb.table('docs/thing.parquet') extend {}
```
