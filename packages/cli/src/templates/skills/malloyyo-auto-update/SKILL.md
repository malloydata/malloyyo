---
name: malloyyo-auto-update
description: Keep a malloyyo GitHub-Pages data site current automatically with a weekly GitHub Actions job — download from the source URL, transform, export parquet, commit. Use after a site is built (see malloyyo-data-site) when the data comes from a public URL that refreshes over time and you want the published site to track it with no manual steps. Worked example: malloydata/malloyyo-imdb.
---

# Auto-update a data site weekly

Add a scheduled GitHub Actions job that rebuilds the data and commits it, so the
published Pages site stays current on its own. Use this **after** the site works
(built with `malloyyo-data-site`). If the data never changes, skip this.

The worked example is `malloydata/malloyyo-imdb` — fetch and read its
`scripts/build_data.sh` and `.github/workflows/refresh-data.yml`; adapt, don't
copy blindly.

## Precondition: one command that rebuilds the data

The whole thing rests on a single script that turns the source URL(s) into the
committed parquet — the same script you'd run by hand. Keep it linear so it
reads as a recipe:

```bash
# scripts/build_data.sh
set -euo pipefail
cd "$(dirname "$0")/.."
bash data/get.sh                                   # 1. download source URLs -> data/
rm -f data/build.duckdb
malloy-cli -c malloy-build.json build transform.malloy   # 2. transform
echo "ATTACH 'data/build.duckdb' AS b (READ_ONLY);      -- 3. export -> docs/*.parquet
      COPY b.thing TO 'docs/thing.parquet' (FORMAT parquet)" | malloyyo sql
```

(If you used Path A — direct — the whole script is just the one
`echo "COPY (FROM read_..('https://…')) TO 'docs/…'" | malloyyo sql` command.
No `data/get.sh`, `malloy-build.json`, `malloy-cli`, or transform needed — and
no standalone `duckdb` either, since `malloyyo sql` uses the embedded one.)

Gitignore the working files: `data/*.gz`, `data/*.duckdb`, `MANIFESTS/`.

## The workflow

`.github/workflows/refresh-data.yml`:

```yaml
name: refresh-data
on:
  schedule:
    - cron: "0 6 * * 0"    # weekly, Sunday 06:00 UTC
  workflow_dispatch:        # ...and on demand from the Actions tab
jobs:
  refresh:
    runs-on: ubuntu-latest
    permissions:
      contents: write       # so the job can commit + push
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      # malloyyo carries its own DuckDB (`malloyyo sql`), so no duckdb CLI to install.
      # Add `@malloydata/cli` only for a `#@ persist` transform (malloy-cli build).
      - run: npm install -g @malloydata/malloyyo @malloydata/cli
      - uses: actions/setup-python@v5              # only if an enrichment step needs it
        with: { python-version: "3.12" }
      - name: Build data
        run: bash scripts/build_data.sh
      - name: Commit refreshed data
        run: |
          git config user.name  github-actions
          git config user.email github-actions@github.com
          git add docs/*.parquet
          git commit -m "refresh data $(date -u +%F)" || exit 0   # unchanged = clean no-op
          git push
```

## Hard-won details (these came from a real first run)

- **`git commit … || exit 0`** — an unchanged week means nothing new upstream.
  That is success, not a failed job.
- **Secondary/enrichment steps must be best-effort.** If the build has a step
  that can fail independently (an external API lookup, an optional metadata
  enrichment) and it isn't essential to the data, mark it
  `continue-on-error: true`. Otherwise one flaky API call throws away an
  otherwise-good data refresh — the commit step never runs and the fresh parquet
  is lost. (In `malloyyo-imdb` this bit us: a poster-image lookup with a missing
  secret failed the whole job until it was made non-blocking.)
- **Secrets** go in repo settings (Settings → Secrets and variables → Actions,
  or `gh secret set NAME`), referenced as `${{ secrets.NAME }}`. A step reading
  a secret that isn't set gets an empty string — pair that with best-effort.
- **No re-bundle needed for data changes.** The dashboards fetch parquet at
  runtime, so committing fresh parquet updates the live site. Only install
  `@malloydata/malloyyo` and run `malloyyo dashboard bundle` in CI if the job
  also needs to regenerate the HTML (i.e. dashboard code changed — rare for a
  data refresh).
- **Test before trusting the schedule.** Push, then Actions tab → the workflow →
  **Run workflow** (that's `workflow_dispatch`). Or `gh workflow run
  refresh-data.yml`, then `gh run watch <id> --exit-status`.

## Git growth, and the flatten

Each committed refresh adds the full parquet to history (~its file size per
run). That is intentional simplicity, not a leak. When history gets too big,
flatten it to a single commit by hand — **not** as part of the weekly job:

```bash
git checkout --orphan flat && git add -A && git commit -m "flatten history"
git branch -M flat main && git push -f origin main
```

Only do this on a repo you solely own (it force-pushes; other clones must
`git reset --hard origin/main`). Run it as often or as rarely as you like.
Document this in the repo's README so future-you remembers it's available.

## Done when

- The workflow file is on the default branch (so `workflow_dispatch` shows up)
- A manual run goes green end-to-end and commits fresh `docs/*.parquet`
- The Pages site shows the new data
