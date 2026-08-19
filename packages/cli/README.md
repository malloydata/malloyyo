# malloyyo

CLI to publish Malloy models to a [Malloyyo](https://github.com/malloydata) instance.

It bundles up the `.malloy` files in a directory plus `malloy-config.json`, records the git
commit they came from, and pushes them to a Malloyyo deployment. The server compiles and
introspects the model — the CLI needs no database connection.

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

The target dataset must already exist; publishing to a missing one fails rather than
inventing it (a config typo would otherwise spawn junk datasets). To provision it from the
CLI instead of the UI, opt in explicitly:

```bash
malloyyo publish main --create-dataset   # create the dataset if it isn't there yet
```

The dataset is created **only after the model compiles**, so a rejected publish still
creates nothing, and it is created **private** — visibility is a deliberate act in the UI,
and publishing never changes it. On an existing dataset the flag does nothing: you just get
the next version. The dataset name comes from the target's `dataset` in the config, and must
already be a valid name (lowercase letters, digits, underscores) — the CLI won't silently
create it under a slugified variant that later publishes wouldn't find.

`publish` exits non-zero on a server-side compile failure, so it's safe to gate CI on.

**Token precedence:** `--token` flag → the `malloyyo_token` env var from config (for CI) →
your `malloyyo login` session. So interactively you just `login` once; in CI you set the env
var and never touch the browser.

See `docs/model-publishing-design.md` in the repo for the full design.

## Malloyyo-hosted instances (`malloyyo cloud`)

For instances Malloyyo runs for you. Everything above works the same on one — a hosted
instance is a URL you `login` to and `publish` at — and these commands are how you get one
and configure it.

```bash
malloyyo cloud instance create acme    # provision acme.malloyyo.com, wait for it to come up
malloyyo cloud instance list
malloyyo cloud instance status acme
malloyyo cloud instance delete acme    # reversible until it is destroyed
```

Name the instance the way you already know it — `acme`, the name in its URL and the one you
`malloyyo login` to. Its ID works too, and is the one to use for an instance that has been
fully destroyed, since its name is free for someone else to take.

`create` prints each provisioning step as it finishes and ends with the URL to sign in at,
which is the same URL you then `malloyyo login`. It provisions real infrastructure, so it
takes minutes; if the command stops waiting, the work continues and `instance status` picks
it up. Every command takes `--json` for a parseable answer instead of progress lines.

### Warehouse secrets

The credentials your Malloy models resolve connections from — the values behind
`{ "env": "NAME" }` in `malloy-config.json`. Several in one command are applied together, and
the command returns once they are live (your instance restarts briefly).

```bash
malloyyo cloud secrets set acme PG_HOST=db.example.com PG_USER=app PG_PASSWORD
op read op://vault/pg/password | malloyyo cloud secrets set acme --stdin
```

A value typed as `NAME=value` lands in your shell history and is visible in `ps` while the
command runs, so there are two ways not to type one: a **bare `NAME`** is prompted for with
the input hidden, and **`--stdin`** reads `NAME=value` lines from a file, a CI variable, or a
password manager. `NAME=value` stays for the parts that are not secrets — a host, a port, a
user. Values are write-only: nothing in this CLI, and no endpoint behind it, reads one back.

### Credentials

`malloyyo cloud` authenticates with a machine credential Malloyyo issues when your account is
created, read from the environment:

```bash
export MALLOYYO_CLIENT_ID=...
export MALLOYYO_CLIENT_SECRET=...
```

That is the whole of it — there is nothing else to configure.

It is separate from `malloyyo login`, which authenticates *you* to one instance. This one
identifies your account to Malloyyo, and each command trades it for a short-lived access
token carrying only the permissions that command needs: a `list` cannot create, and only
`secrets set` can write secrets. The trade happens against Malloyyo's own API, so the CLI
talks to nothing else. Your secret is held in memory for that request and is never logged,
printed, or written to disk.

`MALLOYYO_API_URL` overrides the built-in API address; you should not need to set it.
