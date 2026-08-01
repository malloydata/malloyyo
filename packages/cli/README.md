# malloyyo

The CLI for authoring, testing, and publishing Malloy semantic models and dashboards on
[Malloyyo](https://github.com/malloydata/malloyyo).

> **Full reference: [the CLI guide](../../docs/guide/reference/cli.md).** Start with
> [authoring a model](../../docs/guide/authoring.md) if you're new.

| | |
|---|---|
| `init` | Set up a model repo so `cd repo && claude` opens in author mode |
| `author` / `test` | Launch Claude wired to one surface — build the model, or rehearse what the web will see |
| `mcp` | Run the local stdio MCP server (`--develop` / `--explore`) |
| `dashboard dev` | Live-reloading dashboard preview against the local model |
| `lint` | Validate `./dashboards` against the model |
| `login` / `logout` | Sign in to an instance |
| `publish` / `status` | Push a model version; see what's live |

For `publish`, the CLI bundles the `.malloy` files in a directory plus
`malloy-config.json`, records the git commit they came from, and pushes them to a Malloyyo
deployment; the server does the compiling and introspection. The other commands
(`lint`, `dashboard dev`, `mcp`, and the dashboard-gathering step of `publish`) compile
locally and **do** open the connections your `malloy-config.json` declares.

## Install

The package is published as `@malloydata/malloyyo`; the command it installs is `malloyyo`.
Needs Node ≥ 20.

```bash
npm i -g @malloydata/malloyyo     # then: malloyyo --help
# …or run without installing:
npx @malloydata/malloyyo --help
```

### From source

It lives in the `malloyyo` monorepo as `packages/cli`.

```bash
# from the repo root
npm install
npm run build -w @malloydata/malloyyo   # → packages/cli/dist/index.js

# put `malloyyo` on your PATH (symlink to the built CLI)
cd packages/cli && npm link                # then: malloyyo --help

# …or just run it directly, no link
node packages/cli/dist/index.js --help
```

## Configure

Add a `malloyyo` block to your `malloy-config.json` (or a standalone `malloyyo.json`). One
entry per deployment. **Only the env-var name is committed — never the token value.**

```jsonc
{
  "connections": { /* … */ },
  "malloyyo": {
    "main":    { "url": "https://malloyyo.example.com",         "dataset": "mdw",
                 "malloyyo_token": { "env": "malloyyo_main_token" } },
    "staging": { "url": "https://malloyyo-staging.example.com", "dataset": "mdw_staging",
                 "malloyyo_token": { "env": "malloyyo_staging_token" } }
  }
}
```

## Sign in

```bash
malloyyo login main                         # a named target from the config
malloyyo login https://malloyyo.example.com # a raw URL (no config needed)
malloyyo login                              # omit it if the config has one target
malloyyo logout main
```

Login is **per-instance** (it authenticates you to a URL, for all datasets on it), so the
argument is a *target or URL*, not a dataset — and it's optional when the config is
unambiguous. It uses the instance's OAuth flow (Authorization Code + PKCE, loopback redirect)
and stores a refreshable token in `~/.config/malloyyo/credentials.json` (mode 0600), keyed by
instance URL — so you can be logged in to several instances at once. Tokens auto-refresh.

## Use

```bash
malloyyo publish main           # push the model in . to the "main" target
malloyyo publish staging ./model
malloyyo publish main --dry-run # show what would be sent
malloyyo status main            # what's live: version, commit, compile state
```

`publish` exits non-zero on a server-side compile failure, so it's safe to gate CI on.

**Token precedence:** `--token` flag → the `malloyyo_token` env var from config (for CI) →
your `malloyyo login` session. So interactively you just `login` once; in CI you set the env
var and never touch the browser.

Every other command — `init`, `author`, `test`, `mcp`, `dashboard dev`, `lint` — is
documented in **[the CLI reference](../../docs/guide/reference/cli.md)**. For the publish
design, see [`docs/model-publishing-design.md`](../../docs/model-publishing-design.md).
