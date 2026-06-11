# Design: Loading Malloy models from a git repo without a shared PAT

**Status:** Draft for review
**Author:** (you), with Claude
**Date:** 2026-06-10
**Related planned work:** "Malloy models loadable from a git repo URL" and "Bearer token
auth on MCP endpoint for infrastructure/API use" (CLAUDE.md → Planned work).

---

## 1. Problem

Malloyyo can already load a Malloy model from a GitHub repo, but the auth model doesn't
scale. Today every private-repo fetch goes through a **single, instance-wide
`GITHUB_TOKEN`** (a personal access token in the Vercel env). That PAT is:

- **One identity for the whole instance** — it can only reach repos *its owner* can see.
  On the multi-tenant Guild instance there is no single human whose PAT covers every
  user's private repos.
- **Broadly scoped and expiring** — a classic PAT with `repo` scope is all-or-nothing and
  has to be rotated by hand.
- **A secret the operator holds on the user's behalf** — wrong trust boundary.

We want users to point Malloyyo at a repo (including a private one, including a *branch*)
and have the model show up, **without anyone minting and pasting a PAT.**

## 2. Where the code is today

The pull path already exists and works — this design extends it, it doesn't replace it.

| Concern | Location |
|---|---|
| Repo coordinates on a dataset | `datasets.githubRepo / githubBranch / githubUseToken` (`src/db/schema.ts:113`) |
| Versioned model + per-file storage | `malloyModels`, `malloyModelFiles` (`schema.ts:124`, `:148`) |
| Fetch + introspect + insert a new version | `refreshGitHubModel()` (`src/lib/github-refresh.ts`) |
| Raw GitHub Contents fetch (uses `GITHUB_TOKEN`) | `fetchGitHubFile()` / `GitHubURLReader` (`src/lib/github.ts:6,47`) |
| Manual refresh (admin, session-auth) | `POST /api/datasets/[id]/model/github` |
| Auto refresh on push | `POST /api/datasets/[id]/webhook/github` (public; dataset UUID is the secret) |
| Bearer/OAuth tokens already modeled | `oauthAccessTokens` (`schema.ts:301`) |

Key observation: `refreshGitHubModel` is **pull-shaped**. The webhook removes *polling*,
but the handler at `github-refresh.ts:23,28` still turns around and pulls with
`GITHUB_TOKEN`. So the existing webhook does **not** remove the PAT for private repos — it
only removes the cron. The myth worth killing: *"a webhook lets us load without a PAT."* A
webhook alone never carries repo read auth; the server still needs a credential to fetch the
content.

Two independent axes are tangled together:

- **Direction:** does Malloyyo *pull* from the repo, or does something *push* the model in?
- **Identity:** whose credential authorizes reading the repo?

The PAT pain is entirely on the *pull + shared-identity* corner. The clean way out is to
**flip the direction**: have the model *pushed in* by something that already holds repo
access, so the server needs no git credential at all. That's the design below.

## 3. Goals / non-goals

**Goals**
- Load a model from a repo (public or private) with no instance-wide PAT.
- Support iterating on and testing a **branch** against Claude.
- Carry **provenance** (repo, branch, commit SHA) onto each stored model version.
- Reuse the existing version/file storage and introspection.

**Non-goals (for this doc)**
- Replacing the Claude-authoring path (it stays as one of several model sources).
- Data ingestion changes — the model still references tables already in MotherDuck.

---

## 4. Design — CLI push (`malloyyo` CLI → Malloyyo server)

Invert the direction. Instead of the Malloyyo server reaching *into* the repo, a small
**`malloyyo` CLI pushes the compiled model out** from the user's checkout (or their CI),
where repo access already exists. The server then needs **zero git credentials.**

### 4.1 A separate `malloyyo` CLI (not a `malloy-cli` command)

`publish` lives in its **own tool**, not as a command inside `malloy-cli`. `malloy-cli` is a
vendor-neutral Malloy Foundation project; a command that does authenticated HTTP push to a
specific hosted service — with bearer tokens, instance targets, and a `malloyyo` config
block — sits outside its "thin adapter on core" charter and would couple the neutral CLI to
Malloyyo's release cycle. And the reuse it would gain is small: `publish` **ships the model
files as-is** and lets the server compile + introspect (§4.3), so it needs no DB execution,
no DuckDB bindings, and no connection registry. It's essentially a directory uploader plus
git metadata; the only place it touches Malloy at all is an *optional* local compile-check.

So `malloyyo` is a thin package (`npx malloyyo …`). A repo usually feeds **more than one
deployment** (main, staging, the Guild instance), so the commands take a **named target**;
`publish` operates on a **directory** (the repo / project root):

```
malloyyo publish <target> [dir]      # push the model in <dir> (defaults to ".") to <target>
malloyyo status  <target>            # what's live on <target>: version, commit, compile state
```

What `publish` does:
1. **Resolve the target** — look up `<target>` in the `malloyyo` config (§4.2) for the
   `url`, `dataset`, and token env var. Unknown target → list the available ones and exit.
2. **Gather the directory.** Walk `<dir>` recursively for `*.malloy` files (skipping hidden
   dirs and `node_modules`, like `malloy-cli`'s `fmt`/`build`) and pick up `malloy-config.json`
   at the root. Collect each as `{ path, content }` keyed by its path **relative to `<dir>`**,
   so the layout (and any `import` paths between files) is preserved on the server. This is a
   plain file copy — no parsing, no DB. The server treats `index.malloy` at the root as the
   compile entry point (§4.3); everything it imports rode along in the upload.
3. **Compile-check locally (optional).** If connections are configured, compile via
   `@malloydata/malloy` to fail fast on the user's machine; otherwise skip — the server
   compiles + introspects regardless.
4. **POST** to `<url>/api/datasets/<dataset>/model/push` with the resolved bearer token and
   a body:
   ```jsonc
   {
     "files":  [{ "path": "index.malloy", "content": "..." }, ...],   // every *.malloy under <dir>
     "config": "<malloy-config.json contents, if present>",
     "git":    { "repo": "owner/name", "branch": "feature/x", "sha": "a54a110", "dirty": false }
   }
   ```
   The CLI fills `git` from `git rev-parse HEAD` / `--abbrev-ref HEAD` and a dirty check;
   absent a git dir it sends `generatedBy: cli:local`.
5. **Report status.** The response carries the result — `ok` vs. compile `error`, the new
   `version`, the `sources` found, and the recorded commit. `publish` prints it and **exits
   non-zero on a compile failure** so CI fails loudly. `malloyyo status <target>` fetches the
   same summary for whatever is currently live, without publishing.

### 4.2 Config block — named targets

One repo → many deployments. The `malloyyo` block is a **map of named targets**, each with
its own `url`, `dataset`, and **its own token env ref**:

```jsonc
// malloy-config.json (committed — NO secrets, only env var *names*)
{
  "connections": { /* existing */ },
  "malloyyo": {
    "main":    { "url": "https://malloyyo.vercel.app",         "dataset": "mdw",
                 "malloyyo_token": { "env": "malloyyo_main_token" } },
    "staging": { "url": "https://malloyyo-staging.vercel.app", "dataset": "mdw_staging",
                 "malloyyo_token": { "env": "malloyyo_staging_token" } }
  }
}
```

`malloyyo publish staging` reads the `staging` entry and uses `$malloyyo_staging_token`.

Why a **per-target token env ref** rather than one global `MALLOYYO_TOKEN`: someone working
across several instances (e.g. main + staging, possibly the *same* logical dataset on each)
needs a distinct credential per instance, and wants both live in the shell at once without
collision. Naming the env var per target makes that explicit and lets the same checkout push
to all of them. **Only the env var *name* is committed — never the token value.**

The `{ "env": "..." }` form deliberately mirrors the overlay syntax `malloy-config.json`
already uses for connection secrets, so it reads familiar. The `malloyyo` CLI reads the JSON
file directly and resolves the ref itself (look up the named env var); falls back to a
`--token` flag if it's unset. The block can equally live in a standalone `malloyyo.json` for
projects that'd rather not put a vendor namespace in the neutral config — the CLI checks both.

### 4.3 Server endpoint

New `POST /api/datasets/[id]/model/push`, modeled on the existing
`model/github/route.ts` but:

- **Auth = bearer token**, not session — exactly the planned "Bearer token auth for
  infrastructure/API use." Reuse `oauthAccessTokens` (`schema.ts:301`); resolve token →
  user, check the user owns the dataset. (CI wants a longer-lived token than the current
  24 h OAuth access tokens — see Open Questions.)
- **No git fetch.** Wrap the uploaded files in a `MapURLReader` (a few lines) and call the
  *same* `introspectModelWithReader(reader, "index.malloy", config)` that
  `github-refresh.ts:35` already uses. Then run the identical version-bump + insert into
  `malloyModels` / `malloyModelFiles`.
- **Store provenance for display.** Persist the `git` payload as **structured columns** on
  `malloyModels` — `git_repo`, `git_branch`, `git_sha`, `git_dirty` — not just packed into
  the `generatedBy` string. Structured fields let the UI render a **short SHA**, a **link to
  the commit** (`https://github.com/<repo>/commit/<sha>` when the host is GitHub), the
  branch, and a "dirty" badge when the working tree had uncommitted changes at publish time.
  Keep `generatedBy = "cli:<repo>@<branch>#<short-sha>"` as a human-readable summary too.
  (Small additive migration — `ADD COLUMN IF NOT EXISTS`, per the manual-migration rule in
  CLAUDE.md.)

- **Return status, and expose it.** Respond with the existing `RefreshResult` shape
  (`github-refresh.ts:10`) — `{ ok, version, sources, compiledAt }` or `{ ok:false, error }` —
  extended with the recorded `git` fields, so `publish` can print it and gate CI. Add a
  matching read-only `GET /api/datasets/[id]/model/status` (same bearer auth) that returns the
  live version's `version` + commit + compile state (`compiledAt` / `compileError`) for
  `malloyyo status`.

So ~90% of `refreshGitHubModel` is reused; the only swaps are *where the file bytes come from*
(uploaded map vs. GitHub Contents API) and recording + reporting the pushed commit and status.

### 4.4 What this buys

- **No server-side git credential, ever.** Works for private repos with no grant to
  Malloyyo, and for **any git host**.
- **Branch testing falls out for free:** run `malloyyo publish` from any branch → a new
  model version (or push to a throwaway *preview* dataset). This is the "test branches on
  Claude" experience, with zero auth ceremony.
- **Provenance you can see.** Each version records the exact `repo @ branch # sha` it was
  published from, so the UI can show which commit is live (short SHA + commit link + dirty
  badge) and rollback is unambiguous.
- **CI-native:** drop `malloyyo publish` into the repo's GitHub Action; it uses the runner's
  ambient repo creds — still no PAT. This recovers the one thing push otherwise loses
  (auto-refresh when a *teammate* pushes).

### 4.5 Cost

- **New `malloyyo` workspace package** (in this repo): `publish`/`status` commands +
  directory walk + git metadata (~150 LOC). Ships to npm independently of the server (§7).
- New server route + `MapURLReader` + bearer-auth helper (~120 LOC, mostly reuse).
- Four additive `git_*` columns on `malloyModels` (`ADD COLUMN IF NOT EXISTS` migration).
- A long-lived API-token story (Open Questions).

## 5. Why not become a GitHub App

The obvious alternative — register Malloyyo as a GitHub App so it can mint per-installation
tokens and pull private repos without a shared PAT — was considered and **rejected** for now.
It's what Vercel does, and it's the only way to get hands-off auto-refresh on a private repo
with *no* user-held credential. But it's real infra: an App registration **per instance**
(main/staging/Guild, since callback + webhook URLs differ), RSA private-key management and
rotation, a signature-verified global webhook, a "Connect GitHub" install/redirect flow with
multi-account edge cases, and it's **GitHub-only** (no GitLab/Bitbucket). CLI push removes
the shared PAT with a fraction of that surface and works on any git host, so the App earns
its keep only if someone later needs zero-touch auto-refresh on a private GitHub repo without
a CI step. The good news: the pull machinery (`fetchGitHubFile` already sends
`Authorization: Bearer <token>`, `github.ts:19`) is shaped such that adding it later means
swapping the *token source*, not rewriting the fetch/introspect path — so deferring costs us
nothing.

## 6. Recommendation

**Build the `malloyyo` CLI (push model).** It deletes the shared-PAT problem rather than
working around it, reuses the bearer-token auth we already need (Planned work #2) and the
existing version/file storage, gives branch + preview testing for free, and works for any git
host — all from a thin standalone tool that keeps `malloy-cli` vendor-neutral. Keep today's
`GITHUB_TOKEN` pull path for public / single-owner repos — it's fine there and untouched. Tie
off the long-lived API-token story (Open Questions) as part of the build.

## 7. Packaging & publishing the CLI

**Where it lives.** A pnpm **workspace package inside this repo** (`packages/cli`), not a
separate repo and not in `malloy-cli`. The repo is already pnpm-ready (`pnpm-workspace.yaml`,
`.npmrc`); we add a `packages/*` glob. One repo means the push **wire contract** (the
`model/push` request/response, `src/protocol.ts`) is defined once and shared by both the route
handler and the CLI client — no version skew while the protocol is young. Extracting to its
own repo later is cheap if the CLI ever grows an independent identity (the §5 neutral-protocol
idea).

**Names.** The published CLI is **`malloyyo`** (`bin: malloyyo`, so users type
`malloyyo publish main`), matching the product like `vercel`/`stripe`/`supabase`. The server
keeps its code here but its package is renamed to **`@malloyyo/server`** and stays
`private: true`, so only the CLI publishes. (npm package name and typed command are
independent levers — `bin` decides what you type.)

**Build.** The CLI offloads execution + introspection to the server, so it has **no DuckDB
bindings and no `pkg` binary step** — just an esbuild bundle to `dist/index.js` (the entry's
`#!/usr/bin/env node` shebang is preserved). It pulls `@malloydata/malloy` only if/when we add
the optional local compile-check. This skips all of `malloy-cli`'s `package-npm` / duckdb-sync
machinery.

**Publish — trusted publishing (OIDC), no `NPM_TOKEN`.** Mirror `malloy-cli`'s
`npm-publish.yml`, simplified to pnpm:
- Register `malloyyo` on npmjs.com with a **trusted publisher** = this repo + the publish
  workflow; Actions authenticates via OIDC (`id-token: write`). `publishConfig.provenance`
  attaches a build attestation. Nothing to rotate.
- **`@next`** — auto-publish `0.1.0-next.<date>.<sha>` on every push to `main` (dogfood).
- **`@latest`** — manual `workflow_dispatch` with a semver bump, then commit + tag.
- Publish only the CLI: `pnpm --filter malloyyo publish` — the `private` root is skipped.

Two independent release paths coexist in the repo: the **server** keeps deploying via
`vercel --prod` from the local tree (CLAUDE.md), while **Actions** publishes the **CLI** to
npm. They don't interfere.

## 8. Open questions

- **Long-lived API tokens.** `oauthAccessTokens` is 24 h — too short for CI. Add a
  separate personal/CI token type (hashed, revocable, long TTL), or accept refresh-token
  rotation in CI? Probably a dedicated `api_tokens` concept.
- **Preview datasets.** Should `publish --preview` mint an ephemeral dataset so a branch
  doesn't clobber the main model version, with a TTL/cleanup? Pairs naturally with branch
  testing.
- **Dataset binding — resolved (§4.2):** `malloyyo` is a map of named targets
  (`main`/`staging`/…), each with its own `url`, `dataset`, and token env ref;
  `publish <target>` selects one. Remaining nit: is the `dataset` a UUID or a
  human-friendly slug? A slug survives recreating the dataset and reads better in the
  committed config — worth resolving slug → id server-side.
- **Who creates the dataset?** Does `publish` to an unknown dataset auto-create one (and
  return its id), or must it pre-exist in the UI? Auto-create is friendlier for a
  pure-CLI / CI workflow.
- **Verifying tables exist.** A pushed model references MotherDuck tables; should the server
  reject a push that introspects against missing tables, or store it `failed` like the
  pull path does?
