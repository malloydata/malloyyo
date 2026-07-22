# Setting up a server

You have a model. Now it needs somewhere to live — an address agents can connect
to, a place humans can open a dashboard, a record of what got asked.

That's an **instance**: one deployment of Malloyyo, serving many datasets and
many users.

---

## What an instance actually is

Two moving parts, and neither of them is your data.

**The app** — a Next.js server. It loads a published model, compiles Malloy,
issues the resulting SQL to whatever database the model attaches, and hands back
rows. It is stateless: restart it, scale it, throw it away.

**Postgres** — the metadata store. Datasets, model versions and every model file,
dashboards, users and sessions, OAuth clients and tokens, question history and
saved queries. A free tier is plenty to start.

**Your analytical data stays where it is.** The instance holds no copy of it. It
stores the *question* and the Malloy that answered it — never the rows. DuckDB
runs in-process, so a model that reads Parquet over plain HTTP needs no warehouse
behind it at all; a model that attaches BigQuery or Snowflake connects out at
query time using credentials you set as environment variables.

So the running cost is one web app plus one small Postgres. Everything expensive
stays in the warehouse you already pay for.

---

## Deploy to Vercel

The fastest path is the **Deploy with Vercel** button in the
[README](../../README.md#deploy-your-own). It forks the repo into your GitHub
account and creates a Vercel project, prompting for env vars on the import
screen.

Two things decide whether the first deploy succeeds:

**`DATABASE_URL` is needed at build time.** Not just at runtime — `next build`
evaluates routes that read it, and the build fails without it. Paste a real
Postgres connection string on the import screen ([neon.tech](https://neon.tech)
gives you one free). If you'd rather use Vercel-managed storage, finish the
import with a temporary value, add Postgres under the project's **Storage** tab —
which overwrites `DATABASE_URL` — and redeploy.

**`RUN_MIGRATIONS_ON_BOOT=1` self-initializes the schema.** On startup the server
creates every table it needs. It's idempotent — statements for objects that
already exist are skipped — so it's safe to leave on. There is no migration step
to run and no CLI to install.

The rest of the import screen:

| Variable | What to put |
|---|---|
| `AUTH_SECRET` | `openssl rand -base64 32` |
| `APP_ADMIN_EMAILS` | your email — see [Admins](#admins) |
| `INSTANCE_NAME` / `INSTANCE_CODE` | a display name and a short, unique slug |
| `APP_BASE_URL` | your deployment's URL, e.g. `https://<project>.vercel.app` |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | Google sign-in — safe to leave blank and fill in after the first deploy |

You can't know your deployment URL before the first deploy, and Google's OAuth
client needs it. So: deploy, then create the OAuth client with
`https://<your-domain>/api/auth/callback/google` as its authorized redirect URI,
then set `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` / `APP_BASE_URL` and redeploy.
Until a provider is fully configured, sign-in is disabled — the instance comes up
and says so rather than failing obscurely.

Full list: [environment variables](reference/environment.md).

## Self-host with Docker

The repo ships a production `Dockerfile` — a multi-stage build producing a
minimal Next.js standalone image. The build takes no secrets; real values are
supplied at run time, and the same `RUN_MIGRATIONS_ON_BOOT=1` creates the schema
on first boot. Nothing to mount: state lives in Postgres and your analytical
database.

```bash
docker build -t malloyyo .
docker run --rm -p 3000:3000 --env-file .env malloyyo
```

→ **[Self-hosting with Docker](../docker.md)** for the full build/run reference,
reverse-proxy notes, and a minimal `.env`.

---

## Instance identity

Two variables name this deployment. Neither is cosmetic.

**`INSTANCE_NAME`** (default `Malloyyo`) is the display name — the page title,
the MCP `serverInfo.name`, and a `[Name]` prefix on **every MCP tool
description**. That prefix exists because a person can have several Malloyyo
instances connected to one Claude client at the same time. Without a
distinguishing name in the tool text, the agent has no way to tell your staging
instance from your production one, and will route questions to whichever it
happens to pick.

**`INSTANCE_CODE`** (default `main`) is a short lowercase slug — `main`, `stg`,
`gld`. **It must be unique per deployment.** Every share link is minted as
`<code>_<id>`; when a slug arrives at an instance whose code doesn't match, the
tool rejects it and names the instance it actually belongs to:

```
Slug 'stg_k7m2p9xq4n' belongs to the 'stg' Malloyyo instance, not 'main'
(Malloyyo). Use that instance's tools instead.
```

Give two deployments the same code and you lose that check — a link from one will
be looked up in the other's database, and simply not be found. Set both vars
explicitly on every instance beyond your first.

`INSTANCE_CODE` also keys the editable instance settings row, so each deployment
keeps its own front-page copy even against a shared database.

---

## Sign-in

Three providers are supported: **Google**, **Okta**, and **Microsoft Entra ID**
(Azure AD). Configure any subset.

| Provider | Enabled when these are set |
|---|---|
| Google | `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` |
| Okta | `AUTH_OKTA_CLIENT_ID`, `AUTH_OKTA_CLIENT_SECRET`, `AUTH_OKTA_ISSUER` |
| Microsoft Entra ID | `AUTH_MICROSOFT_ENTRA_ID_ID`, `AUTH_MICROSOFT_ENTRA_ID_SECRET` |

**Only fully-configured providers are registered.** A provider with some of its
vars set but not all is not registered and not advertised — the sign-in page
never shows a button that would fail at the identity provider. A half-configured
provider is logged by name at startup, telling you exactly which var is missing.
If none are ready, sign-in is disabled and the logs say that too.

Every provider posts back to `<APP_BASE_URL>/api/auth/callback/<provider-id>`,
where the ids are `google`, `okta`, and `microsoft-entra-id`. Register the exact
URI — scheme and host included — in the provider's console, plus
`http://localhost:3000/...` if you develop locally.

→ **[Authentication](../authentication.md)** for the per-provider setup.

---

## Admins

**`APP_ADMIN_EMAILS`** is a comma-separated list of email addresses that are
admins on this instance. Admins create datasets, publish models, toggle a dataset
between public and private, and edit the instance settings. Everyone else who can
sign in can query, favorite, share, and open dashboards.

**There is no in-app way to grant admin.** The `/admin/users` page lists users and
shows who is an admin; it does not let you make one. Admin comes from
`APP_ADMIN_EMAILS` or from setting `users.is_admin` directly in the database —
that's the whole story. Get your own email into `APP_ADMIN_EMAILS` before the
first deploy, or you will sign in to an instance you cannot administer.

---

## Who can sign in

> **`EMAIL_ALLOW_LIST` fails open when unset. If you do not set it, anyone with
> a Google (or Okta, or Microsoft) account that reaches your sign-in page can
> sign in, and can query every public dataset on the instance.**

This is deliberate — a demo instance should be open — but it is not what you
want for a company deployment. Set `EMAIL_ALLOW_LIST` to a comma-separated list
of addresses and only those addresses get in.

When it *is* set, it's enforced in three places:

- **at sign-in**, in the Auth.js callback — a non-listed account never gets a
  session;
- **on every page navigation and API request**, from the session — a user removed
  from the list is signed out on their next click;
- **on every MCP call**, re-checked against the token's user.

That third one is the point. An MCP client authorizes once and then keeps itself
connected — an access token lasts a day, its refresh token 90 days, and both are
reissued on every refresh. If the allow-list were only checked at sign-in,
removing someone would leave their agent working indefinitely. Re-checking on
every call means deleting an address from `EMAIL_ALLOW_LIST` and redeploying cuts
off their access on the next tool call.

Restricting to a corporate identity provider is a second, independent lever: an
Okta or single-tenant Entra ID issuer limits sign-in to your org before the
allow-list is ever consulted.

---

## Secrets for your analytical database

Your model's `malloy-config.json` is committed to the repo and ships to the
server on publish, which is why any value in it can be an environment reference
instead of a literal:

```jsonc
{
  "connections": {
    "warehouse": {
      "type": "postgres",
      "host": "db.example.com",
      "password": { "env": "PG_PASSWORD" }
    }
  }
}
```

**The referenced variables must be set on the server.** They're resolved when the
connection opens, so a missing one doesn't surface at publish time — it surfaces
the first time someone runs a query, as a connection failure. Set every `{"env":
…}` name your models reference on the instance, and set the same names locally so
authoring and production behave alike.

A model that only reads Parquet over HTTP, or local files during authoring, needs
nothing here — DuckDB is built in.

**`MOTHERDUCK_TOKEN`** is a special case: setting it points the instance's
built-in DuckDB connection at MotherDuck (`md:`) instead of in-memory DuckDB. Leave
it unset unless you want that.

**`GITHUB_TOKEN`** is unrelated to your data. It's used only when the server pulls
a model from a **private** GitHub repo. Public repos need no token, and the
`malloyyo publish` path needs none at all.

---

## After deploy

1. **Sign in** with an address in `APP_ADMIN_EMAILS`. First sign-in creates your
   user row.
2. **Create a dataset.** Publishing never auto-creates one — a push to a dataset
   that doesn't exist is a 404. From **Admin**, add a Malloy model from GitHub:
   give it `owner/repo`, a branch, and a snake_case dataset name. The repo needs
   an `index.malloy` at its root; the server fetches it, compiles it, and the
   dataset goes `ready`. If it doesn't compile, the dataset is marked failed with
   the compiler error.
3. **Publish into it** from your working tree with `malloyyo publish`, or keep
   refreshing it from GitHub. Either way, each successful publish stores a new
   version and the latest one is live.
4. **Set the instance copy.** `/admin` edits the front-page message shown under
   the instance title and the sign-in notice shown next to the sign-in button.
   Blank either field to restore the built-in default.

→ **[Publishing](publishing.md)** for the publish flow in detail.

---

## Health check

`GET /api/health` runs `SELECT 1` against Postgres and returns the app version:

```json
{ "status": "ok", "postgres": "ok", "version": "0.2.19" }
```

It returns **503** with `"postgres": "unreachable"` and the error detail when the
database can't be reached — the right target for an uptime monitor or a container
health probe. `GET /api/version` returns `{ name, version }`, which is how you
confirm *which* instance answered when several are aliased or forked.

---

**Next:** [Publishing](publishing.md) ·
**Reference:** [environment variables](reference/environment.md)
