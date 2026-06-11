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

## Use

```bash
export malloyyo_main_token=…
malloyyo publish main           # push the model in . to the "main" target
malloyyo publish staging ./model
malloyyo publish main --dry-run # show what would be sent
malloyyo status main            # what's live: version, commit, compile state
```

`publish` exits non-zero on a server-side compile failure, so it's safe to gate CI on.

See `docs/model-publishing-design.md` in the repo for the full design.
