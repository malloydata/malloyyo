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
needs. The schema **self-initializes on first boot** when
`RUN_MIGRATIONS_ON_BOOT=1`, so there is no separate migration step.

```bash
docker run --rm -p 3000:3000 --env-file .env malloyyo
```

Open <http://localhost:3000>.

A minimal `.env` for a first boot:

```bash
# --- required ---
DATABASE_URL=postgresql://user:password@host/dbname?sslmode=require
RUN_MIGRATIONS_ON_BOOT=1                 # create the schema on first boot
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

## Environment reference

See [`.env.local.example`](../.env.local.example) for the full, commented list.
The ones that matter for a container deploy:

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | ✅ | Postgres connection string (e.g. a free [Neon](https://neon.tech) instance). |
| `RUN_MIGRATIONS_ON_BOOT` | first boot | `1` to create/upgrade the schema on startup. Safe to leave on (idempotent). |
| `AUTH_SECRET` | ✅ | Signs session tokens. `openssl rand -base64 32`. |
| `APP_BASE_URL` | ✅ | The public URL the instance is served at; used for OAuth redirects. |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | for sign-in | Google OAuth client. Sign-in is disabled until both are set. |
| Okta / Microsoft Entra ID vars | optional | Additional sign-in providers. See [Authentication](authentication.md). |
| `APP_ADMIN_EMAILS` | recommended | Comma-separated emails that are auto-admins (create datasets, publish). |
| `INSTANCE_NAME` / `INSTANCE_CODE` | optional | Display name + short slug; default `Malloyyo` / `main`. |
| Analytical DB secret | per model | e.g. `MOTHERDUCK_TOKEN`, `BQ_JSON_KEY` — referenced by your model's `malloy-config.json`. |
| `EMAIL_ALLOW_LIST` | optional | Restrict sign-in to specific emails (unset = open instance). |
| `GITHUB_TOKEN` | optional | Only for loading models from private GitHub repos. |

## Notes

- **Port / host.** The image listens on `3000` and binds `0.0.0.0` (both baked
  in via `ENV`). Map it with `-p <host>:3000`, or override `PORT`.
- **Non-root.** The container runs as the unprivileged `node` user.
- **Behind a reverse proxy / TLS.** Terminate TLS at your proxy and set
  `APP_BASE_URL` to the external `https://…` URL so OAuth redirects resolve.
- **Persistence.** Nothing to mount — state is in Postgres and your analytical
  database. Back those up, not the container.
