# Publishing

Publishing is the seam between authoring and serving. It is compile-gated: the
server compiles and introspects what you send before it stores anything, and a
model that doesn't compile never goes live.

There are two ways a model reaches a server — you push it, or the server pulls
it.

---

## Before you can publish

**The dataset has to exist, and publishing does not create it.** An admin
creates it first, on the server.

Today there is exactly one way to create a dataset: **from a GitHub repo**, at
`/datasets/new/github`. The admin supplies `owner/repo`, a branch, and a
snake_case dataset name — that name is what agents and URLs refer to, and what
your publish target points at. The server immediately fetches and compiles
`index.malloy` from that repo as version 1; if it doesn't compile, the dataset is
created in a `failed` state with the error attached.

So even a push-first workflow needs the repo pushed to GitHub once, to bootstrap
the dataset. After that, `malloyyo publish` takes over and the GitHub link is
only used if you ask for it (see [Pull from GitHub](#the-other-way-in-pull-from-github)).

**Publishing requires admin.** The push endpoint authorizes an admin bearer
token, so the account you `malloyyo login` with must be an admin on that
instance. Admin comes from `APP_ADMIN_EMAILS` — see
[Setting up a server](server-setup.md).

## Name your targets

Add a `malloyyo` block to `malloy-config.json` — one entry per deployment:

```jsonc
{
  "connections": { /* … */ },
  "malloyyo": {
    "main":    { "url": "https://malloyyo.example.com",
                 "dataset": "ecommerce",
                 "malloyyo_token": { "env": "malloyyo_main_token" } },
    "staging": { "url": "https://malloyyo-staging.example.com",
                 "dataset": "ecommerce_staging",
                 "malloyyo_token": { "env": "malloyyo_staging_token" } }
  }
}
```

**Only the env-var name is committed, never a token value.** The `malloyyo_token`
entry names a variable to read in CI; interactively you don't need it at all.

(If you'd rather keep it out of the connection config, a standalone
`malloyyo.json` whose whole contents are this map works the same way.)

## Sign in

```bash
malloyyo login main
```

Login is **per instance**, not per dataset — it authenticates you to a URL, for
every dataset on it. So the argument is a target name or a raw URL, and you can
omit it entirely when your config is unambiguous.

It runs the instance's OAuth flow in your browser and stores a refreshable token
in `~/.config/malloyyo/credentials.json`, keyed by instance URL — so you can be
logged in to several instances at once. Tokens refresh themselves.

## Publish

```bash
malloyyo publish main              # push the model in . to the "main" target
malloyyo publish staging ./model   # a different directory
malloyyo publish main --dry-run    # gather and report; send nothing
```

What happens, in order:

1. **Lint runs first.** A broken dashboard never reaches the server.
   `--skip-lint` overrides this.
2. **The CLI gathers** every `.malloy` file in the directory, your
   `malloy-config.json`, and your `dashboards/`.
3. **Git provenance is recorded** — repo, branch, commit sha, and whether the
   tree was dirty. It's printed before sending, and stored with the version.
4. **The server compiles and introspects** the model, then stores it as a new
   version with all its files and dashboards, in one transaction.

```
→ https://malloyyo.example.com  dataset=ecommerce
  7 file(s)  main@a1b2c3d
✓ published version 12 — 4 source(s), 3 dashboard(s)
```

**A compile failure rejects the push and leaves the live model untouched.** The
error is recorded on the dataset so it's visible in the web UI, and `publish`
exits non-zero — which is what makes it safe to gate CI on.

## Check what's live

```bash
malloyyo status main
```

```
main: https://malloyyo.example.com  dataset=ecommerce
  version 12  main@a1b2c3d
  ✓ compiled 2026-07-22T14:02:11Z
```

## Versions

A dataset accumulates versions, and **the latest is the live one**. Because only
models that compiled are ever stored, latest = live = valid; there is no such
thing as a stored-but-broken current model.

Each version keeps `index.malloy`, every other model file, the dashboards, and
the git provenance it came from. That makes "what was serving last Tuesday, and
which commit was it" an answerable question.

## Secrets on the server

Your `malloy-config.json` ships with the model — which is exactly why secrets
belong behind `{ "env": "VAR_NAME" }` references. Those variables must be set on
the **server**, or the model will publish successfully and then fail to connect
when someone asks a question.

Set them before the first publish. See
[environment variables](reference/environment.md).

## In CI

Set the token env var named in your config and skip the browser entirely:

```yaml
- run: npx @malloydata/malloyyo publish main
  env:
    malloyyo_main_token: ${{ secrets.MALLOYYO_TOKEN }}
```

Token precedence is `--token` flag → the config's `malloyyo_token` env var →
your `malloyyo login` session. So interactively you log in once; in CI you set
the variable and never touch a browser.

Since `publish` exits non-zero on a compile failure, this is a real gate — a
merge that breaks the model fails the build rather than breaking production.

## The other way in: pull from GitHub

Instead of pushing, point a dataset at a GitHub repo and the server fetches
`index.malloy` and its imports directly. An admin configures the repo and branch
on the dataset page, and the repo needs `index.malloy` at its root.

A webhook endpoint refreshes it on every push:

```
https://<your-instance>/api/datasets/<dataset-uuid>/webhook/github
```

Add that as a push webhook on the repo and merges to the tracked branch land on
the server automatically. The dataset page shows the URL and has a manual
**Refresh from GitHub** control for pulling on demand.

`GITHUB_TOKEN` on the server is only needed for private repos.

**Which to use.** Push (`malloyyo publish`) gives you a gate: you publish
deliberately, from a tree you've tested, and CI can block a bad model. Pull is
lower-ceremony and good for a model whose repo *is* the source of truth and
whose main branch is always deployable. Both produce ordinary versions; you can
switch.

---

**Next:** [What the server serves](server-surfaces.md) — what your model looks
like to the people and agents using it.
