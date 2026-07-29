# Publish a Malloy dashboard site to GitHub Pages

## How this actually goes

You have a data file and you want a real dashboard site on the internet. There's
no server to run, no database to provision, no cloud account to set up, and
nothing to pay for. The data file ships with the site, and the whole thing runs
in the visitor's browser.

You type two commands. After that you just talk to Claude.

**1. Set up the folder.**

```bash
mkdir mydashboards && cd mydashboards && git init
malloyyo init
```

**2. Start Claude.**

```bash
claude
```

`malloyyo init` wired this folder up, so Claude opens already knowing how to
write and compile Malloy against your data.

**3. Say what you're building.**

> I want to build a dashboard site I can publish on GitHub Pages.

Say this first, before anything else. It decides how everything gets laid out —
where the data goes, how the model refers to it, how the site gets built. Skip it
and you may end up rearranging things later.

**4. Tell it where the data is.**

> The data is sales.parquet, it's in my Downloads folder. Have a look and tell me
> what's in it.

Claude will move it into `docs/` (that's the folder that gets published), read the
schema, poke at the values, and describe what it found. Worth doing before asking
for anything — you'll both know what you're working with, and you'll often spot a
column you forgot about.

**5. Ask for the dashboards you want.** In plain language:

> Build me a dashboard showing revenue by region over time, with a filter for
> product category. And a second one for our top customers.

It writes the semantic model, then the dashboards, compiling against your real
data as it goes and fixing its own mistakes. You don't write any Malloy.

**6. Ask to see them.**

> Let me look at these.

It starts a preview server and gives you a URL. Click around. Then just say what's
wrong: *"the date axis should be by month, not day"*, *"add a filter for sales
rep"*, *"this chart should be a bar chart"*. Iterate until you like it.

**7. Publish when you're ready.**

> Publish this to GitHub.

It builds the static site, commits it, creates the repo, turns on GitHub Pages,
and hands you the URL. Takes about a minute.

Afterwards, changing something is the same loop: tell Claude what you want, look
at it, tell it to publish again.

**What you should know going in:** your data file gets committed to the repo and
served publicly, so this is for data you're happy to make public. Keep it under
about 25 MB — GitHub rejects files over 100 MB, and every visitor downloads the
whole file once.

---

## The detailed version

Everything below is the step-by-step, written so an agent can follow it exactly.
Read on if you want to know what's happening under the hood, or if something went
wrong.

**Audience:** an agent (or a person) taking a dataset from nothing to a live,
public dashboard site. Every step has a **verification gate** — a command whose
output tells you whether to continue. Don't skip a gate; several failure modes
here are silent (a hang with no console error, or a build that goes green and
only breaks in the browser).

**What you end up with:** a static site with **no server, no token, no database,
and no object store**. The data file ships in the repo alongside the pages.
Malloy compiles in the browser and DuckDB-WASM runs the SQL against it. The only
thing you deploy is files.

**Related:** `docs/creating-dashboards.md` (authoring dashboards),
`docs/composite-dashboards.md` (tiled dashboards).

---

## 0. Before you start

You need `node` (20+), `git`, and the `gh` CLI authenticated:

```bash
node --version && git --version && gh auth status
```

**Is this dataset a good fit?** The browser downloads the whole data file once and
queries it locally, and the file lives in your git repo.

| data size | verdict |
|---|---|
| < 25 MB | ideal |
| 25–100 MB | works; first load and `git clone` both get heavy |
| > 100 MB | **GitHub rejects the push.** Use a warehouse-backed deployment instead |

Compression is what matters, not row count: 6.3M rows of baby names is 15 MB as
Parquet.

---

## 1. Create the project

```bash
mkdir ~/dev/myproject && cd ~/dev/myproject
git init
npm install -g @malloydata/malloyyo
malloyyo init
```

**Do `malloyyo init` before anything else.** It writes `.mcp.json`, which is what
lets `claude` open with the Malloy authoring tools wired to this repo — that's how
step 3 stops being work. It also scaffolds `index.malloy` if missing.

**Gate:** `malloyyo --version` prints a version, and `.mcp.json` exists.

---

## 2. Put the data in `docs/` as Parquet

`docs/` is the directory GitHub Pages will serve, so anything you put there is
published alongside the pages — including the data.

```bash
mkdir -p docs
duckdb -c "COPY (SELECT * FROM read_csv_auto('raw.csv')) TO 'docs/mydata.parquet' (FORMAT PARQUET)"
```

Convert to Parquet even if the source is already tabular: it is dramatically
smaller and DuckDB reads it column-wise.

> **Don't put the data under Git LFS.** GitHub Pages and
> `raw.githubusercontent.com` serve the LFS *pointer file* — about 130 bytes of
> text — not your data, and DuckDB will fail on it in a way that looks nothing
> like the real problem. Commit it as an ordinary file, which means staying under
> 100 MB.

If the file is larger than you expected, this shows where the bytes went:

```bash
duckdb -c "SELECT path_in_schema AS col, sum(total_compressed_size) AS bytes
           FROM parquet_metadata('docs/mydata.parquet') GROUP BY col ORDER BY bytes DESC"
```

**Gate:** `duckdb -c "SELECT count(*) FROM 'docs/mydata.parquet'"` returns the
expected row count.

---

## 3. Build the model and dashboards with Claude

Don't hand-write Malloy. `malloyyo init` (step 1) wrote a `.mcp.json`, so from the
repo root:

```bash
claude
```

Claude opens with the local Malloy authoring tools — `compile`, `compile_file`,
`prettify`, `query`, `yo_help` — pointed at the files on disk. It writes the
model, compiles it against your real data as it goes, and fixes its own errors.

Tell it where the data is and what you want:

> The data is at `docs/mydata.parquet`. Build a model over it, then a dashboard
> showing revenue by category over time with a category filter.

**Reference the file by its path relative to the project root** — `docs/mydata.parquet`:

```malloy
source: mydata_table is duckdb.table('docs/mydata.parquet')
```

That one spelling works everywhere. In VSCode and `malloyyo dashboard dev`, DuckDB
reads the file off disk. In the published site — which *is* `docs/` — the page
fetches `./mydata.parquet` and registers it under the model's original name. The
model text never changes between local and published, and because the fetch is
same-origin there is **no CORS to configure anywhere**.

Keeping the data in `docs/` rather than a separate `data/` also means it lives in
git once instead of twice, since `docs/` is committed for Pages.

> **Trap:** every table the model reads must be something a *browser* can fetch —
> a path inside the project, or an `http(s)://` URL. A warehouse connection
> compiles fine on your machine and then fails in the published site, because the
> build runs with your credentials and the browser has none. The build stays
> green; only the live site breaks. The step-5 gate catches this.

**Gate:** `malloyyo lint` passes (it checks each dashboard's query, givens, and
component).

For what a dashboard can do — tiled layouts, custom React components, drills —
see `docs/creating-dashboards.md` and `docs/composite-dashboards.md`.

---

## 4. Test locally

```bash
malloyyo dashboard dev
```

Open the URL it prints. Check each dashboard: controls appear with their default
values, queries return rows, drills work.

**Gate:** every dashboard renders with data. Fix the model here — much faster than
debugging after bundling.

---

## 5. Bundle the static site

```bash
malloyyo dashboard bundle --out docs
```

This serves the result immediately (`--no-serve` to skip). Open it and re-check
every dashboard: this is the artifact that ships, and it runs a different
execution path from `dashboard dev` — DuckDB in the browser rather than a local
server.

Useful flags:

| flag | when |
|---|---|
| `--target vercel` | deploying to Vercel: clean URLs + cache headers |
| `--analytics G-XXXXXXXXXX` | inject Google Analytics 4 |
| `--duckdb bundled` | self-host the wasm (offline / no CDN) — adds ~75 MB |
| `--no-serve` | CI |
| `--title "…"` | site title (defaults to the directory name) |

**Optional: a landing page.** Add `dashboards/index.jsx` exporting a React
component and it becomes the front page instead of the generated list. It receives
`{ dashboards: [{name, title, description, href}] }`, is bundled separately, and
needs no Malloy — keep it plain React and it stays small.

**Gate — check the emitted HTML, because these fail silently:**

```bash
grep -o 'window.__GIVENS__ = \[[^]]*' docs/*.html | head        # must NOT be empty
grep -o '__TABLE_FILES__ = {[^}]*}' docs/assets/model-files.js  # your data file(s)
```

Empty `__GIVENS__` means controls have no specs and every filter starts blank.
`__TABLE_FILES__` maps each table reference to the href the page fetches; for
`docs/mydata.parquet` you should see `"docs/mydata.parquet":"./mydata.parquet"`.
If it's empty, the model isn't reading a fetchable table — see the step-3 trap.

---

## 6. Commit and push

`docs/` is build output, but it **must be committed** — Pages serves what's in the
branch. Your data file is already in there.

```bash
printf '.claude/\n' >> .gitignore
git add -A
git commit -m "publish: static dashboard site in docs/"
gh repo create myorg/myproject --public --source=. --push   # first time
# or: git push origin main
```

DuckDB comes from the jsDelivr CDN by default, so **no wasm binaries are
committed**. With `--duckdb bundled`, expect ~75 MB in git — permanently.

---

## 7. Turn on GitHub Pages

```bash
gh api -X POST repos/myorg/myproject/pages \
  -f "source[branch]=main" -f "source[path]=/docs"
gh api -X PUT repos/myorg/myproject/pages -F https_enforced=true
```

The response includes `html_url` — note it, especially if your org has a custom
domain, because Pages uses that instead of `myorg.github.io`.

**Gate — wait for the build, then test the live site including the data:**

```bash
until s=$(gh api repos/myorg/myproject/pages/builds/latest --jq .status); \
  [ "$s" = built ] || [ "$s" = errored ]; do sleep 10; done; echo "$s"

SITE=$(gh api repos/myorg/myproject/pages --jq .html_url)
curl -sL -o /dev/null -w "%{http_code}\n" "$SITE"
curl -sL -o /dev/null -w "%{http_code} %{size_download} bytes\n" "$SITE/mydata.parquet"
```

That second request is the one that matters: it proves the browser can actually
get the data. Then open the site and click through every dashboard.

---

## GitHub Pages constraints worth knowing

- **No custom response headers.** So no COOP/COEP, so no cross-origin isolation,
  so DuckDB runs **single-threaded**. Fine at this data size; a hard ceiling, not
  a preference. (Vercel can set headers — use `--target vercel`.)
- **Project sites live under a base path** (`/reponame/`). Asset URLs must be
  relative; the bundler handles this, but it's why a hand-edited absolute path
  will 404.
- **`.nojekyll`** is emitted automatically — without it Jekyll silently drops
  paths beginning with an underscore.
- **1 GB site limit, 100 GB/month soft bandwidth limit.** A 20 MB site is ~5,000
  cold visits a month.

## Troubleshooting

| symptom | cause |
|---|---|
| Page loads, spinner forever, **no console error** | A DuckDB asset 404'd. Its URL is resolved inside the worker, so a relative path resolves against the worker's directory. Look for a 404 ending in `.wasm`. |
| Dashboards render but are **empty** | The data file 404'd, or `__TABLE_FILES__` is empty. Check the network panel for the `.parquet`. |
| DuckDB errors on a file that clearly exists | The data is under **Git LFS** — you're being served a 130-byte pointer. |
| Controls appear with **no values** | `__GIVENS__` is empty in the HTML — the given specs weren't introspected. |
| Tiles show **fewer rows than expected** | A per-query `limit:` in the model; the host default is 5000. |
| **`process is not defined`** at load | A browser bundle missing the `assert`/`util` shims — file a bug, `browserBuildBase()` should apply them. |
| Builds fine, **breaks only in the browser** | The model reads a table the browser can't fetch — a warehouse connection. See step 3. |

## Updating the site

```bash
malloyyo dashboard bundle --out docs --no-serve && git add docs && \
  git commit -m "rebuild dashboards" && git push
```

The published site reads its model from the **snapshot** inlined at bundle time
(`docs/assets/model-files.js`), not from your working tree. Editing `.malloy`
files changes nothing live until you re-bundle and push — so you can iterate
freely without touching the published site.

To refresh the data, overwrite `docs/mydata.parquet` and push. No re-bundle is
needed unless the schema changed.

---

### Cheat sheet

| Step | Command |
|------|---------|
| Install | `npm install -g @malloydata/malloyyo` |
| Set up the repo | `malloyyo init` |
| Data → `docs/` | `duckdb -c "COPY (…) TO 'docs/mydata.parquet' (FORMAT PARQUET)"` |
| Build the model | `claude` → "the data is at `docs/mydata.parquet`, build …" |
| Validate | `malloyyo lint` |
| Preview | `malloyyo dashboard dev` |
| Bundle | `malloyyo dashboard bundle --out docs` |
| Publish | `git add -A && git commit && git push` |
| Turn on Pages | `gh api -X POST repos/OWNER/REPO/pages -f "source[branch]=main" -f "source[path]=/docs"` |
