# Publishing the site on GitHub Pages

The published site is just the `docs/` directory: bundled HTML plus the parquet
it queries. GitHub Pages serves it directly — no build step on GitHub's side.

## One-time setup

```bash
# from the repo root, after `malloyyo dashboard bundle --out docs`
gh repo create <owner>/<name> --public --source=. --remote=origin   # or an existing repo
git add -A
git commit -m "initial data site"
git push -u origin main
```

Turn on Pages, pointing at the `docs/` folder on the default branch:

```bash
gh api -X POST repos/<owner>/<name>/pages \
  -f 'source[branch]=main' -f 'source[path]=/docs'
```

(Or in the UI: Settings → Pages → Source: **Deploy from a branch** → Branch
`main`, folder `/docs`.)

The site appears at `https://<owner>.github.io/<name>/` within a minute or two.

## Why `docs/` and why `.nojekyll`

- Serving from `/docs` on the main branch keeps the data committed **once**
  (it's the same directory you build into), not duplicated on a separate branch.
- `malloyyo dashboard bundle` writes a `.nojekyll` file so Pages serves the
  bundled assets as-is instead of running them through Jekyll (which would drop
  files beginning with `_`). Keep it committed.

## Updating the site

Re-run the data step and the bundle, then commit `docs/`:

```bash
bash scripts/build_data.sh        # or your Path-A duckdb command → docs/*.parquet
malloyyo dashboard bundle --out docs
git add docs && git commit -m "update" && git push
```

Because the dashboards fetch the parquet client-side, **committing fresh parquet
is enough to update the live data** — you only need to re-`bundle` when you
change dashboard code. To automate the data refresh weekly, see the
`malloyyo-auto-update` skill.

## Gotchas

- **Data must be in `docs/` before you bundle** — the pages fetch `./*.parquet`
  relative to the site root; `bundle` also reads the parquet to get schemas.
- **Big parquet grows git history.** Each committed refresh adds the full file.
  Fine for occasional updates; for frequent auto-refresh, see the flatten note
  in `malloyyo-auto-update`.
- **Git LFS does not work with Pages "deploy from a branch"** — Pages serves the
  LFS pointer text, not the file. Commit parquet as normal git objects.
- **Private repos**: Pages on private repos needs a paid plan. Use a public repo
  for a public site.
