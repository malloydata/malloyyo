# API tokens

An API token lets the [`malloyyo` CLI](../packages/cli) — or a CI job, or a
script — act as you on an instance with no browser sign-in. It is the credential
to reach for whenever `malloyyo login` is impossible or wrong: a GitHub Actions
runner, a container, a cron job, a machine you do not want holding a
refreshable session.

**Every member of an instance can mint their own.** You do not need to be an
admin, and you can only ever mint one for yourself.

## Mint one

In the instance's UI: your landing page → **tokens**, or go straight to
`<instance-url>/settings/tokens`.

| Field | What it is for |
| --- | --- |
| **Name** | What this token is, in your words — `github actions`, `laptop`, `nightly refresh`. It is how you will recognize it in the list a year from now. |
| **Scopes** | What the token may reach. Tick as few as the job needs. |
| **Expires** | 30 days, 90 days, 1 year, or **never**. |

Scopes:

| Scope | What it opens |
| --- | --- |
| `publish` | `malloyyo publish` and `malloyyo status` — the CLI's model surface |
| `mcp` | querying the instance's published models over MCP |

A publishing CI job wants `publish` alone. A script that asks the instance
questions wants `mcp` alone. Both is fine for a credential you use by hand.

**The value is shown exactly once**, at creation, as the line you are about to
need:

```bash
export MALLOYYO_TOKEN=myo_main_…
```

Only a hash of it is stored, so nothing — no page, no endpoint, no
administrator — can show it to you again. A token you did not copy is revoked
and replaced, not recovered.

## Use it

The CLI reads `MALLOYYO_TOKEN` from the environment. That is the whole of it:

```bash
export MALLOYYO_TOKEN=myo_main_…
malloyyo publish            # no login, no browser, no --token
malloyyo status
```

In GitHub Actions, store the token as a repository secret and hand it to the
step:

```yaml
# .github/workflows/publish-model.yml
name: publish model
on:
  push:
    branches: [main]

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm i -g @malloydata/malloyyo
      - run: malloyyo publish
        env:
          MALLOYYO_TOKEN: ${{ secrets.MALLOYYO_TOKEN }}
          # Whatever your malloy-config.json resolves connections from, too:
          # WAREHOUSE_PASSWORD: ${{ secrets.WAREHOUSE_PASSWORD }}
```

`publish` exits non-zero when the model does not compile, so the job fails
loudly and the live model is left untouched.

Secrets your **model** needs (the `{ "env": … }` values in
`malloy-config.json`) are a separate matter: they are resolved on the server
that compiles the model, so they belong in *that deployment's* environment, not
in the CI job. The CI job needs only the token.

### Which credential wins

The CLI resolves a bearer token in this order:

1. `--token <value>` on the command line
2. the env var named by the target's `malloyyo_token: { env: … }` in
   `malloy-config.json`
3. `$MALLOYYO_TOKEN`
4. the session stored by `malloyyo login`

A target's own variable beats `MALLOYYO_TOKEN` because someone publishing to
main *and* staging from one shell needs a credential per instance, and one
variable can only hold one of them. Both variables beat the stored login,
because a CI container has no credentials file and an export is deliberate.

That last point has a sharp edge worth knowing: **an export left in your shell
profile shadows `malloyyo login`**. Two things push back on it — `login` tells
you when the variable is set, and every authentication failure names the source
it actually used, so you are never guessing which credential was rejected.

## What a token can do

A token is never more than its owner. Every request re-reads your user row and
re-runs the same authorization the web session does, so a token grants what you
can do *at that moment* — not what you could do when it was minted. Scopes only
narrow it further.

The same scopes apply to the credential `malloyyo login` stores: it asks for
`mcp publish`, so a login can publish. A **claude.ai connection asks for `mcp`
alone and cannot publish** — a credential you delegated for querying should not
also be able to overwrite a model. If your saved login predates publish scopes,
publishing answers `this credential does not carry the "publish" scope` and the
CLI tells you to sign in once more.

Concretely, with a `publish` token:

- **Publish to a dataset you own**, or to any dataset if you are an admin.
- **Not** publish to someone else's dataset. The CLI says whose problem it is:
  `that account doesn't own dataset "x" and isn't an admin on this instance`.
- **Not** create a dataset. `--create-dataset` is admin-only, the same as
  creating one in the UI — a token must not be a way around that gate.

## Expiry, rotation, revocation

**"Never" is a real answer.** A credential that lapses on its own breaks a
pipeline at the worst possible moment, and nobody is watching the token list on
the day it happens. The controls that actually work are the two on the page:
every token shows when it was **last used**, so a forgotten one is visible, and
**Revoke** takes effect on the token's very next request — no redeploy, no
waiting for an expiry.

Rotation is revoke-and-replace: mint the new token, update the CI secret,
revoke the old one. There is no in-place rotation, deliberately — a token's
value is its identity, and a "rotate" that changed the value under the same row
would silently break whatever still held the old one.

Disabling the person does the same thing to all of their tokens at once
(`status = disabled` on the user row), which is the lever to pull when someone
leaves.

## The token format, and why it matters

```
myo_main_uAD8TQ0mF1t2wPtKZd-9Vu_eBIoHNQqLvGqYK1tSQnE
└┬┘ └─┬┘ └────────────────────┬─────────────────────┘
 │    │                       └── 32 random bytes, base64url
 │    └── the instance's INSTANCE_CODE
 └── marker: this is a Malloyyo API token
```

Three things fall out of that shape:

- **A wrong secret is diagnosed, not just rejected.** If `MALLOYYO_TOKEN` holds
  something else — a warehouse password, say — the CLI says so instead of
  relaying a bare `401`.
- **A token from the wrong instance says so.** Hand a staging token to
  production and the answer is `that token was minted on "stg"; this instance is
  "main"`, not a mystery failure.
- **Secret scanners can match it.** The `myo_` prefix is a stable, greppable
  pattern for GitHub push protection, `gitleaks`, or your own CI check.

Never commit a token. `malloy-config.json` is designed so you do not have to:
it holds only the *name* of an environment variable, never a value.

## Troubleshooting

| What you see | What it means |
| --- | --- |
| `invalid or revoked token` | The value is not a live token here — revoked, expired, or never existed. The message names which variable it came from. |
| `…that value isn't shaped like a Malloyyo token…` | The variable holds something that is not a token at all. Check whether the name is still in use for another secret. |
| `that token was minted on "x"; this instance is "y"` | Right token, wrong instance. Mint one at the instance you are publishing to. |
| `this credential does not carry the "publish" scope` | The credential is fine; it was not given this permission. For a token: mint a new one with the scope ticked — scopes are fixed at creation. For a saved login from before publish scopes existed: run `malloyyo login` again. |
| `that account doesn't own dataset "…"` | Ownership, not authentication. The dataset's owner or an admin can publish to it. |
| `dataset "…" not found, and creating one is admin-only` | Ask an admin to create the dataset, then publish to it. |
| Publishing works by hand but not in CI | Almost always precedence: something in the shell profile is shadowing what you think you set. `malloyyo publish` names the source it used in any auth failure. |

## For operators

- **Nothing to configure.** The feature is on wherever the instance runs; the
  table arrives with the schema (`drizzle/0018_api_tokens.sql`).
- **Set `INSTANCE_CODE` per deployment** if you run more than one (`main` /
  `stg` / `gld`). It is what makes a cross-instance token report itself, and it
  is the same variable that prefixes share slugs.
- **Tokens are per person, and private to them.** The endpoints scope every
  read and write to the caller's own user id, so an admin cannot list, mint, or
  revoke someone else's. To cut off a person, disable the person.
- **A token is capped at 20 live per user**, so a compromised browser session
  cannot mint an unbounded set.
- **Logs name the credential**, not the secret: a publish records
  `token:<name>` or `oauth:<client-id>`, so "which pipeline pushed version 12"
  is answerable after the fact.

## Where the code lives

| Piece | File |
| --- | --- |
| Minting, hashing, format, validation | `src/lib/api-tokens.ts` |
| One resolver for every bearer surface | `src/lib/bearer-auth.ts` |
| The page and its controls | `src/app/settings/tokens/` |
| List / mint / revoke endpoints | `src/app/api/tokens/` |
| The table | `src/db/schema.ts`, `drizzle/0018_api_tokens.sql` |
| CLI precedence and advice | `packages/cli/src/oauth.ts`, `packages/cli/src/index.ts` |

Related: **[Authentication](authentication.md)** for how sign-in and membership
work, and `docs/model-publishing-design.md` for the publish path this
credential was built for.
