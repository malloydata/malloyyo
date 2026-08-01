# Environment variables

Everything a Malloyyo **server** reads from its environment. Set these on your
Vercel project, in your container's env file, or in a `local/<instance>` file for
local development — see [`.env.local.example`](../../../.env.local.example) for a
commented starting point.

Defaults apply when the variable is unset or empty.

---

## Required

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | Postgres connection string for the metadata database. **Needed at build time as well as run time** — `next build` evaluates routes that read it. No default; the server throws `Missing required env var: DATABASE_URL`. |
| `AUTH_SECRET` | Signs session tokens. Generate with `openssl rand -base64 32`. Also signs OAuth authorization blobs (see `OAUTH_SIGNING_SECRET`) and the short-lived capability tokens the sandboxed dashboard iframe uses to load its own bundle — so a missing value breaks sign-in, MCP authorization, and dashboards alike. |

## Instance identity

| Variable | Default | Meaning |
|---|---|---|
| `INSTANCE_NAME` | `Malloyyo` | Display name — page title, MCP `serverInfo.name`, `/api/version`, and a `[Name]` prefix on every MCP tool description so an agent connected to several instances routes to the right one. |
| `INSTANCE_CODE` | `main` | Short lowercase slug prefixed onto every share link (`<code>_<id>`). **Must be unique per deployment** — a slug from another instance is detected and rejected with a pointer to the one it belongs to. Also keys this instance's editable settings row. Lowercased on read. |
| `APP_BASE_URL` | `http://localhost:3000` | The public URL this instance is served at. Match it when registering OAuth redirect URIs (`<APP_BASE_URL>/api/auth/callback/<provider-id>`). |

## Sign-in & access

A provider is registered and advertised on the sign-in page **only when all of its
required vars are set**. Partial configuration is logged by name at startup and
the provider stays off. See [Authentication](../../authentication.md).

| Variable | Meaning |
|---|---|
| `APP_ADMIN_EMAILS` | Comma-separated emails that are admins: create datasets, publish models, toggle dataset visibility, edit instance settings. Matched case-insensitively. There is no in-app way to grant admin — this var or a direct `users.is_admin` database edit. |
| `EMAIL_ALLOW_LIST` | Comma-separated emails allowed to use the instance. **Unset means open** — any account from a configured provider can sign in. When set, enforced at sign-in, on every session-authenticated page and API request, and on every MCP call (so removing an address cuts off existing tokens on the next call rather than at expiry). |
| `AUTH_GOOGLE_ID` | Google OAuth client ID. Required for Google sign-in. |
| `AUTH_GOOGLE_SECRET` | Google OAuth client secret. Required for Google sign-in. |
| `AUTH_OKTA_CLIENT_ID` | Okta OIDC client ID. Required for Okta sign-in. |
| `AUTH_OKTA_CLIENT_SECRET` | Okta client secret. Required for Okta sign-in. |
| `AUTH_OKTA_ISSUER` | Okta issuer URL, e.g. `https://yourorg.okta.com`. Required for Okta sign-in. An empty value is normalized to unset. |
| `AUTH_MICROSOFT_ENTRA_ID_ID` | Microsoft Entra ID (Azure AD) application (client) ID. Required for Microsoft sign-in. |
| `AUTH_MICROSOFT_ENTRA_ID_SECRET` | Entra ID client secret. Required for Microsoft sign-in. |
| `AUTH_MICROSOFT_ENTRA_ID_ISSUER` | Optional. Set to `https://login.microsoftonline.com/<tenant-id>/v2.0/` to restrict sign-in to one organization; unset falls back to the `common` authority (any Microsoft account). **An empty value is normalized to unset at startup** — Auth.js would otherwise assign a top-level `issuer: ""` that fails its endpoint assertion and invalidates the *entire* sign-in config, not just this provider. |
| `OAUTH_SIGNING_SECRET` | Optional override for the HMAC key that signs the pending-authorization blob in the OAuth 2.1 flow. Falls back to `AUTH_SECRET`, then `NEXTAUTH_SECRET`. |
| `NEXTAUTH_SECRET` | Legacy Auth.js v4 name, honored only as the last fallback for the OAuth signing key. Prefer `AUTH_SECRET`. |

## Data & models

| Variable | Default | Meaning |
|---|---|---|
| `MOTHERDUCK_TOKEN` | unset | When set, the built-in DuckDB connection opens `md:` (MotherDuck) instead of in-memory DuckDB. Leave unset for plain DuckDB — models attach their own sources. |
| `MOTHERDUCK_DATABASE` | `mayolo` | Read by the env module; the MotherDuck connection currently opens `md:` without it, so setting it has no effect on query routing. |
| `GITHUB_TOKEN` | unset | Bearer token for GitHub Contents API reads. Needed **only** for pulling models from private repos (classic scope `repo`, or fine-grained `contents:read`). Public repos and the `malloyyo publish` path need nothing. |
| *your model's `{"env": …}` names* | — | `malloy-config.json` can reference any variable (e.g. `PG_PASSWORD`, `BQ_JSON_KEY`, `ANALYTICAL_DATABASE_SECRET`). Resolved when the connection opens, so a missing one fails at query time, not at publish time. Set the same names locally and on the server. |

## Operational

| Variable | Default | Meaning |
|---|---|---|
| `RUN_MIGRATIONS_ON_BOOT` | unset (off) | Any non-empty value creates the full current schema on startup. Idempotent — "already exists" errors are skipped — and a failure is logged without crashing startup. The one-click Vercel deploy sets it to `1`; managed instances leave it off and run SQL migrations by hand. |
| `LOG_LEVEL` | `info` | Minimum level written: `debug`, `info`, `warn`, `error`. An unrecognized value falls back to `info`. Output is JSON in production, human-readable otherwise. |
| `MODEL_DEF_CACHE` | unset (off) | `1` or `true` enables the durable compiled-ModelDef cache, which lets a cold instance rehydrate a compiled model from Postgres instead of recompiling. **Currently disabled in production** — it keys by model id alone and collides across entry files, so dashboards could rehydrate the wrong model. Leave it off until that is fixed; see [`TODO.md`](../../../TODO.md). |
| `PORT` | `3000` | Standard Next.js port. Baked into the Docker image along with a `0.0.0.0` bind. |
| `NODE_ENV` | — | Set by the framework. `production` switches logging to JSON. Don't set it by hand. |

---

## Notes

**Build time vs. run time.** Only `DATABASE_URL` is needed to *build*. Everything
else is read at run time, so you can change sign-in providers, admins, or the
allow-list and redeploy without touching the model or the schema.

**Empty is not the same as unset — except where it is.** `isSet()` treats a
whitespace-only value as unset when deciding whether a sign-in provider is
configured, and the two `*_ISSUER` vars are deleted from the environment when
empty. Elsewhere, an empty string is just an empty string.

**Related:** [Setting up a server](../server-setup.md) ·
[Authentication](../../authentication.md) ·
[Self-hosting with Docker](../../docker.md)
