---
description: Publishing dashboards — `malloyyo dashboard bundle` builds a static site (GitHub Pages / Vercel) with an optional dashboards/index.jsx landing page; plus the malloyyo config block
---

# Publishing dashboards as a static site

`malloyyo dashboard bundle` turns a model's dashboards into a **self-contained
static site**: one HTML page per dashboard, plus a landing page. There is no
server — the page runs DuckDB-WASM in the browser and fetches the model's data
files directly, so anything that serves static files (GitHub Pages, Vercel, S3)
can host it.

That's a different thing from `malloyyo publish`, which uploads the model to a
**hosted Malloyyo instance** for the MCP/claude.ai surface. A repo commonly does
both: `publish` for the conversational surface, `bundle` for the public site.

```bash
malloyyo dashboard dev                  # local preview while authoring
malloyyo lint                           # validate before you build
malloyyo dashboard bundle               # build ./docs, then serve it to look at
malloyyo dashboard bundle --no-serve    # CI / just build
```

## Options

| flag | default | what it does |
| --- | --- | --- |
| `-o, --out <dir>` | `docs` | output directory (`docs/` is what GitHub Pages serves from a branch) |
| `--target pages\|vercel` | `pages` | host conventions — see below |
| `--duckdb cdn\|bundled` | `cdn` | where DuckDB's wasm comes from |
| `--title <title>` | project dir name | site title |
| `--no-serve` | serves | build only |
| `-C, --root <dir>` | cwd | project root |

**`--target`.** `pages` writes `.nojekyll` (Jekyll silently drops paths starting
with `_`, which bundlers emit). `vercel` instead writes a `vercel.json` with
`cleanUrls` and a long immutable cache on `/duckdb/` + `/assets/`, and drops the
`.html` from internal links — only Vercel can rewrite extensionless paths, so on
a plain static host a clean URL would just 404.

**`--duckdb`.** `cdn` references jsDelivr at the exact installed version —
immutable, CORS-open, brotli (~6.8 MB), nothing committed. `bundled` copies the
binaries in for a fully self-contained, offline-capable site, at ~75 MB — which
on a Pages deploy means 75 MB **in git**. Stay on `cdn` unless you need
third-party independence.

## What lands in the output directory

```
docs/
  index.html               # landing page
  <name>.html              # one per dashboard
  assets/                  # hashed JS chunks, site.css, model-files.js
  <data files>             # copied at their project-relative paths
  .bundle-manifest.json    # what the build copied (so it can clean up)
  .nojekyll | vercel.json  # per --target
```

Each run clears `assets/`, `duckdb/` and `*.html` before regenerating — esbuild
hashes chunk names, so without that every build leaves the last one's chunks
behind to be committed and served. Hand-added files (a `CNAME`, a `README`)
survive. Data files are tracked in `.bundle-manifest.json` so a file that moves
doesn't leave an orphan copy behind.

## Data: local files are copied, URLs are not

Every **project-relative** data file the dashboards actually reach is copied into
the site preserving its path, so the page fetches it **same-origin** — no CORS to
configure. A model reading a path that doesn't exist fails the build with that
path named.

An **absolute URL** is left alone and fetched cross-origin, which requires CORS
on that host. Both patterns are in use: commit the parquet next to the site for a
fully self-contained deploy, or point at a bucket you already serve.

Only files reachable from the dashboards are copied — an unused table in the
model costs nothing.

## The landing page: `dashboards/index.jsx`

Without one, the build emits a plain generated list of dashboards. Ship
`dashboards/index.jsx` (or `.tsx`) for a real written introduction — it receives
the dashboard list as a prop:

```jsx
// dashboards/index.jsx — plain React. No Malloy, no DuckDB, no givens.
export default function Landing({ dashboards }) {
  //     dashboards: [{ name, title, description, href }, …]
  return (
    <main className="lp">
      <h1>Baby Names</h1>
      <p>Every US Social Security name record since 1880.</p>
      <ul className="cards">
        {dashboards.map((d) => (
          <li key={d.name}>
            <a href={d.href}>
              <strong>{d.title}</strong>
              <span>{d.description}</span>
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}
```

Three things make it different from a dashboard component:

- **It gets its own esbuild pass.** Sharing the dashboard build would pull
  Malloy, DuckDB and the renderer into the landing page's chunk; keeping it
  separate means the intro page stays tiny and the heavy runtime loads only when
  someone opens a dashboard. So keep it React-only.
- **It is NOT sandboxed in an iframe**, so it styles itself with the *page's*
  variables — `--line`, `--card`, `--muted`, `--accent`, `--fg` — NOT the
  `--dash-*` variables. Those are the iframe's, and a dashboard component's rules
  referencing `--line` silently resolve to nothing (see `yo_help
  dashboards/custom-components`). The two scopes are exact opposites; don't copy
  CSS between them without re-resolving the colours.
- **It has no `index.malloy` behind it** and is exempt from `lint`'s
  orphaned-component check. `index` is reserved for this — you cannot have a
  dashboard named `index`.

## Project settings: the `malloyyo` block

`malloy-config.json` holds connections; a sibling `malloyyo` block holds project
settings and publish targets:

```json
{
  "connections": { "duckdb": { "is": "duckdb" } },
  "malloyyo": {
    "analytics": "G-XXXXXXXXXX",
    "targets": {
      "prod": {
        "url": "https://your-instance.vercel.app",
        "dataset": "babynames",
        "malloyyo_token": { "env": "MALLOYYO_PUBLISH_TOKEN" }
      }
    }
  }
}
```

- `analytics` — GA4 Measurement ID for the built site. It's a property of the
  project, so every rebuild picks it up. Unset = no analytics, no third-party
  script, no cookies.
- `targets` — named `malloyyo publish` destinations. `malloyyo_token` takes the
  `{ "env": … }` form so the token is never committed (`yo_help
  develop/connection-setup`).

Only `analytics` and `targets` are known keys; anything else warns. Targets
written directly at the top of the block is the legacy shape — it still works and
still warns.

## Keeping a published site current

The site is static, so refreshing data means rebuilding the data files and
committing them — a scheduled GitHub Action that regenerates the parquet and
commits it back is enough, with no re-bundle needed as long as the schema hasn't
changed. Re-run `malloyyo dashboard bundle` when the model or the dashboards
change.
