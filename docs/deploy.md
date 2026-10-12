# Deploying Malloyyo

Run your own Malloyyo server: one click to Vercel, a Docker container, or a local dev server.

## Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fmalloydata%2Fmalloyyo&env=DATABASE_URL,AUTH_SECRET,AUTH_GOOGLE_ID,AUTH_GOOGLE_SECRET,APP_ADMIN_EMAILS,APP_BASE_URL,INSTANCE_NAME,INSTANCE_CODE&envDescription=Paste%20a%20Postgres%20DATABASE_URL.%20See%20the%20checklist%20for%20the%20rest.&envLink=https%3A%2F%2Fgithub.com%2Fmalloydata%2Fmalloyyo%2Fblob%2Fmain%2Fdocs%2Fdeploy.md%23deploy-to-vercel&project-name=malloyyo&repository-name=malloyyo)

The button forks the repo into your GitHub and creates a Vercel project. The schema
**creates and upgrades itself at boot** (migrations are on by default in production;
set `RUN_MIGRATIONS_ON_BOOT=0` only if you want to manage the schema yourself), so
you never run a migration. The import screen prompts for these env vars:

1. **`DATABASE_URL`** — a Postgres connection string (you can get a free instance from
   [neon.tech](https://neon.tech)). **The build needs it, so paste one here.**
   *Prefer Vercel-managed storage? Finish the import with a temporary value, then add
   Postgres under the project's **Storage** tab — it overwrites `DATABASE_URL` — and
   redeploy.*
2. **`AUTH_SECRET`** — `openssl rand -base64 32`.
3. **`APP_ADMIN_EMAILS`** — your email (admins add datasets / publish).
4. **`INSTANCE_NAME` / `INSTANCE_CODE`** — a display name + a short, unique slug (e.g. `gld`).
5. **`AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`** — for sign-in; you can leave these blank now
   and fill them after the first deploy (next step).
6. **`APP_BASE_URL`** — your deployment's URL, e.g. `https://<yourproject>.vercel.app`.

**Then enable Google sign-in:** create a Google OAuth app (Google Cloud Console →
Credentials → Web application), set its authorized redirect URI to
`https://<your-domain>/api/auth/callback/google`, put the client ID/secret + your
`APP_BASE_URL` into the project's env vars, and redeploy.

> Prefer Okta or Microsoft Entra ID (Azure AD) sign-in, or want the full
> details? See **[Authentication](authentication.md)**.

After that, sign in with the admin email and add a dataset.

Malloyyo sends a small allowlist of anonymized, server-side product-usage events by
default. It never sends query text, SQL, results, URLs, email addresses, or raw user IDs.
Self-hosters can stop all Malloyyo product telemetry by setting
`MALLOYYO_TELEMETRY_DISABLED=1`, or inspect the sanitized events without sending them by
setting `MALLOYYO_TELEMETRY_DEBUG=1`. See [Product telemetry](telemetry.md) for the
exact event/property allowlist, privacy boundaries, and pseudonymous identities.

> Your model's `malloy-config.json` references your analytical database's secret from an
> env var (e.g. `ANALYTICAL_DATABASE_SECRET` — see [Developing Malloy models](developing-models.md)). Set that var on the project so the server can connect. `GITHUB_TOKEN` is optional (private-repo model pulls).

## Self-host with Docker

Prefer containers to Vercel? The repo ships a production `Dockerfile`. See
**[Self-hosting with Docker](docker.md)** for build and run instructions.

## Running locally

Copy `.env.local.example` to `local/<instance>` and fill in the blanks:

```bash
DATABASE_URL=postgresql://...          # Neon (or any Postgres)
APP_BASE_URL=http://localhost:3000
APP_ADMIN_EMAILS=you@example.com
AUTH_SECRET=...                        # openssl rand -base64 32
AUTH_GOOGLE_ID=...                     # Google OAuth client ID
AUTH_GOOGLE_SECRET=...                 # Google OAuth client secret
# GITHUB_TOKEN=github_pat_...          # Optional; needed for private repos
# MALLOYYO_TELEMETRY_DISABLED=1        # Optional; self-hosted product telemetry opt-out
```

**Google sign-in** needs a Google OAuth app — Google Cloud Console → APIs & Services →
Credentials → **Create OAuth client ID** → type **Web application**. Put its client
ID/secret into `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`, and add this **Authorized redirect
URI**:

```
http://localhost:3000/api/auth/callback/google
```

(Miss this and Google rejects sign-in with `redirect_uri_mismatch`.)

Okta and Microsoft Entra ID (Azure AD) sign-in are also supported — see
**[Authentication](authentication.md)** for all three.

```bash
npm install
npx dotenv-cli -e local/main -- npx tsx scripts/run-boot-migrations.ts   # first run only
npx dotenv-cli -e local/main -- npm run dev
```

Open <http://localhost:3000>.
