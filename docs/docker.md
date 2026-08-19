# Self-hosting with Docker

The repo ships a production `Dockerfile` — a multi-stage build (`node:22`) that
produces a minimal Next.js **standalone** image (`node server.js`, ~450 MB). Use
it to self-host Malloyyo anywhere that runs containers, instead of deploying to
Vercel.

Malloyyo is stateless: all persistent state lives in **Postgres** (metadata +
auth) and your **analytical database** (your data). The container holds neither,
so you can run, restart, and scale it freely.

## Build

```bash
docker build -t malloyyo .
```

The build needs no secrets. It bakes in placeholder `DATABASE_URL` /
`MOTHERDUCK_TOKEN` values only to satisfy `next build` — database init is lazy
and never connects at build time. Real values are supplied at **run** time.

## Run

Point the container at a Postgres database and give it the auth/instance env it
needs. The schema **self-initializes on first boot and upgrades itself on every
later one** — boot migrations are on by default in production (drizzle-orm's
migrator applies the `drizzle/` journal), so there is no separate migration
step and nothing to configure. If a migration fails, the instance stays up but
reports unready — `GET /api/health` answers 503 with the error — instead of
serving a half-migrated schema.

```bash
docker run --rm -p 3000:3000 --env-file .env malloyyo
```

Open <http://localhost:3000>.

A minimal `.env` for a first boot:

```bash
# --- required ---
DATABASE_URL=postgresql://user:password@host/dbname?sslmode=require
AUTH_SECRET=...                          # openssl rand -base64 32
APP_BASE_URL=http://localhost:3000       # the URL this instance is served at

# --- sign-in (Google OAuth) ---
AUTH_GOOGLE_ID=...apps.googleusercontent.com
AUTH_GOOGLE_SECRET=...
APP_ADMIN_EMAILS=you@example.com         # these emails are auto-admins

# --- instance identity (optional; shown here are the defaults) ---
INSTANCE_NAME=Malloyyo
INSTANCE_CODE=main

# --- analytical database secret (per your model's malloy-config.json) ---
# MOTHERDUCK_TOKEN=...
# BQ_JSON_KEY=...
```

For Google sign-in, add this **Authorized redirect URI** to your OAuth client
(Google Cloud Console → Credentials → Web application), matching `APP_BASE_URL`:

```
<APP_BASE_URL>/api/auth/callback/google      # e.g. http://localhost:3000/api/auth/callback/google
```

### If the container exits immediately

```
[startup] Missing required env var: APP_BASE_URL
```

Set `APP_BASE_URL` to the public URL the instance is served at, including the
scheme (`https://malloyyo.example.com`). This is enforced rather than warned
about: without it the instance advertises whatever origin a caller asks it to,
which points MCP clients at an attacker's authorization server. It is required
only for this deployment path — `npm run dev` and Vercel deployments both work
without it, since neither sits behind a proxy that leaves the header
caller-controlled.

## Environment reference

See [`.env.local.example`](../.env.local.example) for the full, commented list.
The ones that matter for a container deploy:

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | ✅ | Postgres connection string (e.g. a free [Neon](https://neon.tech) instance). |
| `RUN_MIGRATIONS_ON_BOOT` | no (on by default) | The schema creates/upgrades itself on startup (the `drizzle/` migration journal; concurrent instances serialize on an advisory lock; an up-to-date database boots with a single lookup). Set `0` only to manage the schema out-of-band — e.g. the app runs under a database role without DDL rights, applied via `npx tsx scripts/run-boot-migrations.ts`. |
| `AUTH_SECRET` | ✅ | Signs session tokens. `openssl rand -base64 32`. |
| `APP_BASE_URL` | ✅ | The public URL the instance is served at. Pins every origin the instance hands out — OAuth redirects, the discovery documents, `/ltool` share links. **The container refuses to start without it**, because the alternative is deriving those from the request's `Host` / `X-Forwarded-Host`, which the caller controls behind a proxy that doesn't overwrite it. |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | for sign-in | Google OAuth client. Sign-in is disabled until both are set. |
| Okta / Microsoft Entra ID vars | optional | Additional sign-in providers. See [Authentication](authentication.md). |
| `APP_ADMIN_EMAILS` | recommended | Comma-separated emails that are auto-admins (create datasets, publish). |
| `GITHUB_WEBHOOK_SECRET` | recommended | Enables HMAC verification of GitHub's push webhook. Unset, the dataset UUID in the webhook URL is its only protection. Use the same value in the webhook's Secret field on GitHub. |
| `DASHBOARD_TOKEN_SECRET` | optional | Signs dashboard frame tokens; defaults to `AUTH_SECRET`. |
| `INSTANCE_NAME` / `INSTANCE_CODE` | optional | Display name + short slug; default `Malloyyo` / `main`. |
| Analytical DB secret | per model | e.g. `MOTHERDUCK_TOKEN`, `BQ_JSON_KEY` — referenced by your model's `malloy-config.json`. |
| `BREAK_GLASS_EMAIL` | optional | Emergency door: admits this one address as an admin even when the database says no. Membership itself is managed in /admin (first sign-in becomes the owner). |
| `GITHUB_TOKEN` | optional | For private GitHub repos — and any token also lifts public-repo fetches off GitHub's anonymous 60/hour-per-IP budget, which shared cloud egress IPs have usually already spent. |
| `GITHUB_TOKEN_FALLBACK` | optional | A platform-wide default token used only when `GITHUB_TOKEN` is unset or empty. Lets an operator authenticate public-repo fetches fleet-wide without claiming the `GITHUB_TOKEN` name from users. |

## Notes

- **Port / host.** The image listens on `3000` and binds `0.0.0.0` (both baked
  in via `ENV`). Map it with `-p <host>:3000`, or override `PORT`.
- **Non-root.** The container runs as the unprivileged `node` user.
- **Behind a reverse proxy / TLS.** Terminate TLS at your proxy and set
  `APP_BASE_URL` to the external `https://…` URL so OAuth redirects resolve.
- **Persistence.** Nothing to mount — state is in Postgres and your analytical
  database. Back those up, not the container.
