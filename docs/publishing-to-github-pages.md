# Guide: publish a Malloy dashboard site to GitHub Pages

**Audience:** an agent (or a person) taking a dataset from nothing to a live,
public dashboard site. Every step has a **verification gate** — a command whose
output tells you whether to continue. Do not skip a gate; several of the failure
modes below are silent (a hang with no console error, or a build that goes green
and only breaks in the browser).

**What you end up with:** a static site with **no server, no token, and no
database**. Malloy compiles in the browser; DuckDB-WASM runs the SQL against a
public Parquet file over https. The only thing you deploy is files.

**Related:** `docs/creating-dashboards.md` (authoring dashboards),
`docs/composite-dashboards.md` (tiled dashboards).

---

## 0. Before you start

You need `node` (20+), `git`, the `gh` CLI authenticated, and — for hosting your
own data — `gcloud`. Check:

```bash
node --version && git --version && gh auth status && gcloud config get project
```

**Decide first: is this dataset a good fit?** The browser downloads the whole
data file once and queries it locally. That is excellent up to a few tens of MB
and wrong at gigabytes.

| data size | verdict |
|---|---|
| < 50 MB | ideal |
| 50–200 MB | works, but first load gets slow |
| > 200 MB | use a warehouse-backed deployment instead, not this |

Compression is what matters, not row count: 6.3M rows of baby names is 15 MB as
Parquet.

---

## 1. Create the project

```bash
mkdir ~/dev/myproject && cd ~/dev/myproject
git init
npm install -g @malloydata/malloyyo     # or: npx @malloydata/malloyyo …
malloyyo init
```

`malloyyo init` writes `.mcp.json` (so `claude` opens in author mode) and
scaffolds `index.malloy` if missing.

**Gate:** `malloyyo --version` prints a version.

---

## 2. Get the data, and make it a Parquet file

Find the source data (a CSV, a TSV, a database export, an existing Parquet).
Convert to Parquet — it is dramatically smaller and DuckDB reads it column-wise:

```bash
duckdb -c "COPY (SELECT * FROM read_csv_auto('raw.csv')) TO 'mydata.parquet' (FORMAT PARQUET)"
```

Two things worth doing now, because they are hard to change later:

- **Trim columns you will not query.** Every byte is downloaded by every visitor.
- **Check which column dominates.** If one wide string column is most of the
  file and every query touches it, no amount of clever reading will avoid
  downloading the whole thing:

```bash
duckdb -c "SELECT path_in_schema AS col, sum(total_compressed_size) AS bytes
           FROM parquet_metadata('mydata.parquet') GROUP BY col ORDER BY bytes DESC"
```

**Gate:** the file exists and `duckdb -c "SELECT count(*) FROM 'mydata.parquet'"`
returns the expected row count.

---

## 3. Publish the data to Google Cloud Storage

The browser must fetch this file directly, so it has to be **publicly readable
over https**.

```bash
BUCKET=my-public-bucket
gcloud storage buckets create gs://$BUCKET --uniform-bucket-level-access   # once
gcloud storage buckets add-iam-policy-binding gs://$BUCKET \
  --member=allUsers --role=roles/storage.objectViewer                      # once
gcloud storage cp mydata.parquet gs://$BUCKET/mydata.parquet
```

**Gate — must return `200`:**

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://storage.googleapis.com/$BUCKET/mydata.parquet
```

---

## 4. Set CORS on the bucket

**This step is mandatory and easy to get wrong.** Without it the browser refuses
to read the file and the dashboards render empty.

`cors.json`:

```json
[{
  "origin": ["*"],
  "method": ["GET", "HEAD"],
  "responseHeader": ["Content-Type", "Range", "Content-Range", "Content-Length", "ETag", "Accept-Ranges"],
  "maxAgeSeconds": 3600
}]
```

```bash
gcloud storage buckets update gs://$BUCKET --cors-file=cors.json
```

**Why `origin: ["*"]` is not a security downgrade here:** CORS is not access
control. The object is already public and unauthenticated — anyone can `curl` it.
CORS only decides whether a *browser* lets a page read a response it was already
allowed to fetch. Restricting origins protects nothing; it just breaks every new
localhost port and preview URL you use. The one real cost is that anyone can
hotlink the file against your egress bill — if that matters, list your origins
explicitly instead (scheme + host + port, exact match, no wildcards).

**Gate — do NOT trust a `HEAD` request here.** A cached `HEAD` can come back
without CORS headers and look like failure. Verify with the two requests the
browser actually makes:

```bash
# 1. preflight (DuckDB sends a Range header, which is not CORS-safelisted)
curl -sI -X OPTIONS -H "Origin: https://example.com" \
  -H "Access-Control-Request-Method: GET" -H "Access-Control-Request-Headers: range" \
  "https://storage.googleapis.com/$BUCKET/mydata.parquet" | grep -i access-control

# 2. a real ranged GET
curl -s -o /dev/null -D - -H "Origin: https://example.com" -H "Range: bytes=0-1023" \
  "https://storage.googleapis.com/$BUCKET/mydata.parquet?cb=$RANDOM" | grep -i "access-control\|content-range"
```

You need `access-control-allow-methods: GET,HEAD`, `Range` among the allowed
headers, and the ranged GET returning `206` with `access-control-allow-origin`.

---

## 5. Build the semantic model

Use the **two-file storage pattern**. Keep the storage binding in its own file
so switching between local development and published data is a one-line change.

`gs.malloy` — what the published site uses:

```malloy
source: mydata_table is duckdb.table('https://storage.googleapis.com/my-public-bucket/mydata.parquet')
```

`md.malloy` — optional, for faster local iteration against a warehouse. Define
**the same source names**:

```malloy
source: mydata_table is md.table('mydb.mydata')
```

`mydata.malloy` — the model. Import exactly one storage file:

```malloy
##! experimental { access_modifiers givens }

import "gs.malloy"

given:
  # label="Category" control=select suggest { source: mydata dimension: category }
  CATEGORY :: filter<string> is f'Widgets'

source: mydata is mydata_table extend {
  measure: total is count()
  dimension: year is date_col.year
}
```

`index.malloy` — the published surface:

```malloy
import { mydata, CATEGORY } from './mydata.malloy'
export { mydata, CATEGORY }
```

> **Trap:** when you bundle, the model must reference only tables the browser
> can fetch — i.e. `http(s)://` URLs. If you bundle while importing `md.malloy`,
> the build succeeds (it compiles server-side with your warehouse credentials)
> and then **fails in the browser**, where no such connection exists. Always
> confirm the import line before bundling.

Then author dashboards in `dashboards/` — see `docs/creating-dashboards.md`. A
dashboard is a `dashboards/<name>.malloy` with a `# artifact` tag; add an
optional `dashboards/<name>.jsx` to draw it yourself.

**Gate:** `malloyyo lint` passes.

---

## 6. Test locally

```bash
malloyyo dashboard dev
```

Open the URL it prints. Check each dashboard: controls appear with their default
values, queries return rows, and drills/links work.

**Gate:** every dashboard renders with data. Fix the model here — it is much
faster than debugging after bundling.

---

## 7. Bundle the static site

```bash
malloyyo dashboard bundle --out docs
```

This serves the result immediately (`--no-serve` to skip). Open it and re-check
every dashboard — this is the artifact that ships, and it runs a different
execution path from `dashboard dev` (browser DuckDB rather than a local server).

Useful flags:

| flag | when |
|---|---|
| `--target vercel` | deploying to Vercel: clean URLs + cache headers |
| `--duckdb bundled` | self-host the wasm (offline / no CDN) — adds ~75 MB |
| `--no-serve` | CI |
| `--title "…"` | site title (defaults to the directory name) |

**Optional: a landing page.** Add `dashboards/index.jsx` exporting a React
component and it becomes the site's front page instead of the generated list. It
receives `{ dashboards: [{name, title, description, href}] }`. It is bundled
separately, so keep it plain React — no Malloy imports — and it stays small.

**Gate — check the emitted HTML, because these fail silently:**

```bash
grep -o 'window.__GIVENS__ = \[[^]]*' docs/*.html | head        # must NOT be empty
grep -o '__REMOTE_TABLES__ = \[[^]]*\]' docs/assets/model-files.js  # your https URLs
```

An empty `__GIVENS__` means controls have no specs and every filter starts blank.
An empty `__REMOTE_TABLES__` means the model isn't pointing at a fetchable table
(see the trap in step 5).

---

## 8. Commit and push

`docs/` is build output, but it **must be committed** — GitHub Pages serves what
is in the branch.

```bash
printf '.claude/\n' >> .gitignore
git add -A
git commit -m "publish: static dashboard site in docs/"
gh repo create myorg/myproject --public --source=. --push   # first time
# or: git push origin main
```

By default DuckDB comes from the jsDelivr CDN, so **no wasm binaries are
committed**. If you used `--duckdb bundled`, expect ~75 MB in git — permanently.

---

## 9. Turn on GitHub Pages

```bash
gh api -X POST repos/myorg/myproject/pages \
  -f "source[branch]=main" -f "source[path]=/docs"
gh api -X PUT repos/myorg/myproject/pages -F https_enforced=true
```

The response includes `html_url` — note it, especially if your org has a custom
domain, because Pages will use that instead of `myorg.github.io`.

**Gate — wait for the build, then test the live site:**

```bash
until s=$(gh api repos/myorg/myproject/pages/builds/latest --jq .status); \
  [ "$s" = built ] || [ "$s" = errored ]; do sleep 10; done; echo "$s"

SITE=$(gh api repos/myorg/myproject/pages --jq .html_url)
curl -sL -o /dev/null -w "%{http_code}\n" "$SITE"
```

**Final gate — verify CORS from the real production origin,** not from
`example.com`. This is the check that proves a visitor's browser can actually
load the data:

```bash
ORIGIN=$(echo "$SITE" | sed -E 's#(https?://[^/]+).*#\1#')
curl -s -o /dev/null -D - -H "Origin: $ORIGIN" -H "Range: bytes=0-1023" \
  "https://storage.googleapis.com/$BUCKET/mydata.parquet" | grep -i access-control-allow-origin
```

Then open the site and click through every dashboard.

---

## GitHub Pages constraints worth knowing

- **No custom response headers.** So no COOP/COEP, so no cross-origin isolation,
  so DuckDB runs **single-threaded**. Fine for this data size; it is a hard
  ceiling, not a preference. (Vercel can set headers — use `--target vercel`.)
- **Project sites live under a base path** (`/reponame/`). Asset URLs must be
  relative; the bundler handles this, but it is why a hand-edited absolute path
  will 404.
- **`.nojekyll`** is emitted automatically — without it Jekyll silently drops
  paths beginning with an underscore.

## Troubleshooting

| symptom | cause |
|---|---|
| Page loads, spinner forever, **no console error** | A DuckDB asset 404'd. Its URL is resolved inside the worker, so a relative path resolves against the worker's directory. Check the network panel for a 404 ending in `.wasm`. |
| Dashboards render but are **empty** | CORS. Re-run the step-4 gates using your real origin. |
| Controls appear with **no values** | `__GIVENS__` is empty in the HTML — the given specs weren't introspected. |
| Tiles show **fewer rows than expected** | A per-query `limit:` in the model; the host default is 5000. |
| **`process is not defined`** at load | A browser bundle missing the `assert`/`util` shims — file a bug, `browserBuildBase()` should apply them. |
| Builds fine, **breaks only in the browser** | The model imports `md.malloy` (or another non-fetchable table). See step 5. |

## Updating the site

```bash
malloyyo dashboard bundle --out docs --no-serve && git add docs && \
  git commit -m "rebuild dashboards" && git push
```

The published site reads its model from the **snapshot** inlined at bundle time
(`docs/assets/model-files.js`), not from your working tree. Editing `.malloy`
files changes nothing live until you re-bundle and push — which also means you
can freely switch back to `md.malloy` for local work without touching the live
site.
