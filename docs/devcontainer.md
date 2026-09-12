# The Malloyyo dev container

One prebuilt container that any Malloy model repo can open a **GitHub Codespace**
(or a local **Dev Container**) on, with everything needed to build a model and
its dashboards already installed — including Claude, so the "ask Claude to build
the model" loop works from the first minute rather than after an afternoon of
setup.

```
ghcr.io/malloydata/malloyyo-devcontainer:latest
```

It is built and published by this repository
([`.devcontainer/Dockerfile`](../.devcontainer/Dockerfile),
[`.github/workflows/devcontainer.yml`](../.github/workflows/devcontainer.yml)),
so starting a codespace on it is a **pull, not a build**.

## Use it in a model repo

Copy [`examples/devcontainer/devcontainer.json`](../examples/devcontainer/devcontainer.json)
to `.devcontainer/devcontainer.json` in your model repo and commit it. That is
the entire setup:

```jsonc
{
  "name": "Malloy model",
  "image": "ghcr.io/malloydata/malloyyo-devcontainer:latest",
  "postCreateCommand": "malloyyo init",
  "postAttachCommand": "malloyyo-devcontainer-info"
}
```

Then **Code → Codespaces → Create codespace** on that repo (or, locally, VS
Code's *Dev Containers: Reopen in Container* with Docker running).

You do not list the extensions, the remote user or the dashboard ports: the
image carries them itself in a `devcontainer.metadata` label, which the Dev
Containers tooling merges into your configuration. Anything you *do* write in
your `devcontainer.json` wins, so adding a `forwardPorts`, another extension or
a feature works normally.

`malloyyo init` in `postCreateCommand` is what makes `claude` open in **author
mode** in that repo — it writes `.mcp.json` (the `malloyyo mcp --develop`
server), pre-approves that server's tools in `.claude/settings.json`, and
scaffolds an `index.malloy` if the repo has none. It merges rather than
overwrites, so it is safe on every rebuild; once you have committed what it
writes you can drop the line.

## What's in it

| | |
| --- | --- |
| **Claude Code** | `claude` on the CLI, plus the **Claude Code** VS Code extension (`anthropic.claude-code`) driving the same binary |
| **Malloy** | the **Malloy** VS Code extension (`malloydata.malloy-vscode`) — schema browsing, query execution, result rendering |
| **`malloyyo` CLI** | `@malloydata/malloyyo`: `init`, `lint`, `dashboard dev`, `mcp`, `login`, `publish`, `test` |
| **Node 24** | the same major CI and the Vercel Functions runtime use, plus `npm`, `typescript`, `tsx` — the React/TypeScript side of dashboards |
| **Playwright + Chromium** | at `/opt/pw-browsers`, so Claude can open a dashboard it just wrote and look at it |
| **Google Cloud CLI** | `gcloud` and `bq`, for BigQuery-backed models |
| **DuckDB CLI** | `duckdb` — the engine Malloy uses by default; handy for poking at a Parquet or CSV file before modelling it |
| **git, git-lfs, gh, jq** | the usual |

Ports **4173** (the dashboard preview) and **4174** (the frame's separate,
untrusted origin — the preview needs both) are forwarded automatically.

## Working in it

```bash
claude                      # author the model with Claude, in author mode
malloyyo lint               # compile every .malloy file
malloyyo dashboard dev      # dashboard preview on 4173, auto-forwarded
malloyyo test               # dress rehearsal: exactly what claude.ai will see
malloyyo login <instance> && malloyyo publish <instance>
```

`malloyyo-devcontainer-info` reprints that list any time.

Codespaces forwards 4173 with an authenticating cookie in front of it; the
dashboard preview is built to work behind exactly that (its frame ships inlined
rather than fetched, so the cross-site request that would lose the cookie never
happens). Click the forwarded-port link and it renders.

### BigQuery

Malloy's BigQuery connector reads Application Default Credentials, so both
logins are worth doing once per codespace:

```bash
gcloud auth login --no-launch-browser                    # for gcloud/bq
gcloud auth application-default login --no-launch-browser # what Malloy reads
gcloud config set project <project-id>
bq query --use_legacy_sql=false 'select 1'               # sanity check
```

`--no-launch-browser` prints a URL to open on your own machine and takes the
code back — the flow that works when the browser is not on the same host as the
container. Credentials live in `~/.config/gcloud` and survive stopping and
restarting the codespace, but not rebuilding it.

For a service account instead, put the JSON in a **Codespaces secret** and point
`GOOGLE_APPLICATION_CREDENTIALS` at a file you write from it — never commit it.

### Secrets and tokens

Repo → **Settings → Secrets and variables → Codespaces**. They arrive as
environment variables. The two that come up:

- **`MALLOYYO_TOKEN`** — a personal API token (`/settings/tokens` on your
  instance) with the `publish` scope, so `malloyyo publish` needs no browser
  sign-in. See [API tokens](api-tokens.md).
- Any `{ "env": "…" }` value your `malloy-config.json` references for the
  analytical database.

## Pinning, and staying current

`:latest` deliberately tracks the latest `malloyyo`, Claude Code, DuckDB and
Chromium — the workflow rebuilds it weekly as well as on every change to
`.devcontainer/`. Two consequences:

- **Mid-session, take a newer CLI without rebuilding:** `npm i -g
  @malloydata/malloyyo@latest` (the npm global prefix is owned by `vscode`, so
  no `sudo`).
- **If you need a fixed environment**, pin a digest or a `sha-…` tag instead of
  `:latest`:

  ```jsonc
  { "image": "ghcr.io/malloydata/malloyyo-devcontainer:sha-<commit>" }
  ```

  Every publish prints its immutable `@sha256:…` reference in the workflow run's
  summary.

## Making it launch even faster: prebuilds

The published image removes the build; **Codespaces prebuilds** remove the rest
— the extension installs and your `postCreateCommand`. Worth turning on for a
repo whose codespaces get created often: repo → **Settings → Codespaces → Set up
prebuild**, pointing at the branch(es) you work on. GitHub then keeps a prepared
container ready and creation drops to seconds.

## Changing the image

Edit [`.devcontainer/Dockerfile`](../.devcontainer/Dockerfile) and open a PR.
The workflow builds it and asserts every promised tool actually runs — in a
login shell, which is what a VS Code terminal is — before anything is published.
On merge to `main` it publishes `:latest` and `:sha-<commit>`.

Adding a VS Code extension for everyone means adding it to the
`devcontainer.metadata` label at the bottom of the Dockerfile, not to a
consuming repo.

Locally, to build and try it without CI:

```bash
docker build -t malloyyo-devcontainer .devcontainer   # native on Apple Silicon
```

The published image is `linux/amd64`, which is what Codespaces runs; on Apple
Silicon Docker will emulate it, so build locally if you want native speed.

## This repository's own container

[`.devcontainer/devcontainer.json`](../.devcontainer/devcontainer.json) opens
*malloyyo itself* in the same image, plus what only the server repo needs: the
docker-in-docker feature (`npm run test:hosted` and `npm run test:migrate` stand
up an ephemeral Postgres), port 3000, and `npm ci` on create. It references the
published image rather than building the Dockerfile beside it, so this repo is
on the same path — and gets the same image — as everyone else.
