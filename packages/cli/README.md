# malloyyo

CLI to publish Malloy models to a [Malloyyo](https://github.com/malloydata) instance.

It bundles up the `.malloy` files in a directory plus `malloy-config.json`, records the git
commit they came from, and pushes them to a Malloyyo deployment. The server compiles and
introspects the model — the CLI needs no database connection.

## Install

```bash
npm i -g malloyyo        # or: npx malloyyo …
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

See `docs/model-publishing-design.md` in the repo for the full design.
