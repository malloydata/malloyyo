---
name: run-dev
description: Launch the app locally against an ephemeral Postgres with seeded signed-in sessions, so you can browse it (including /admin, as admin or member) with no auth provider configured. Use when asked to run or start the dev server, look at or screenshot the app, or verify a change in the real UI (e.g. "run the app", "start dev and look", "does /admin render?").
---

# run-dev

Run the app for a look, hermetically: ephemeral database, seeded users and
sessions, throwaway secret. Nothing here touches a real environment, and
teardown deletes all of it. Verified end to end on 2026-08-05.

**What it gets you:** the app on a local port, with browsable sessions for an
admin and a plain member — no Google/Okta configured, no sign-in flow. It works
because OSS mode uses NextAuth **database** sessions: a row in `sessions` plus a
cookie naming its token *is* a signed-in user.

**What it cannot show:** hosted-mode surfaces (managed-provider login and
contributed admin pages). Those need a composed hosted build.

## 1. Database

Docker must be running (`docker info`; on macOS `open -a Docker` and wait).
Port **55433** and a distinct container name, so the test harness
(`yo-hosted-test-pg` on 55432) never collides:

```bash
docker rm -f yo-dev-pg 2>/dev/null
docker run -d --name yo-dev-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=postgres \
  -p 55433:5432 postgres:16-alpine
```

Wait for readiness the way `scripts/hosted-test.sh` does — **TCP check, three
in a row**. The image boots a throwaway init server on the unix socket first; a
socket check passes on it prematurely and the schema apply then hits the
"database system is shutting down" window:

```bash
streak=0
for _ in $(seq 1 120); do
  if docker exec yo-dev-pg pg_isready -h 127.0.0.1 -U postgres -d postgres >/dev/null 2>&1; then
    streak=$((streak + 1)); [ "$streak" -ge 3 ] && break
  else
    streak=0
  fi
  sleep 0.5
done
```

Apply the schema (non-interactive, unlike `drizzle-kit push`):

```bash
npx drizzle-kit export 2>/dev/null | \
  docker exec -i yo-dev-pg psql -U postgres -d postgres -q -v ON_ERROR_STOP=1
```

## 2. Seed people and sessions

Known tokens, one admin, one member — the member exists so authorization
behavior (redirects, 403s) can be checked, not just the happy path:

```bash
docker exec -i yo-dev-pg psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 <<'SQL'
WITH admin_user AS (
  INSERT INTO users (name, email, is_admin, status, role) VALUES ('Ada Admin', 'ada@test.local', true, 'active', 'owner') RETURNING id
), member_user AS (
  INSERT INTO users (name, email, is_admin, status, role) VALUES ('Mo Member', 'mo@test.local', false, 'active', 'member') RETURNING id
)
INSERT INTO sessions (session_token, user_id, expires)
SELECT 'dev-admin-session-token', id, now() + interval '1 day' FROM admin_user
UNION ALL
SELECT 'dev-member-session-token', id, now() + interval '1 day' FROM member_user;
SQL
```

## 3. Launch

Port 3000 is often taken by the developer's own server — check, and default to
**3010**. Three env vars, all throwaway; `AUTH_SECRET` is required or every
`auth()` call fails with `MissingSecret`:

```bash
cd <this repo> && \
DATABASE_URL='postgres://postgres:test@localhost:55433/postgres' \
APP_BASE_URL='http://localhost:3010' \
AUTH_SECRET='dev-only-ephemeral-secret' \
npm run dev -- -p 3010
```

In a Claude session, put exactly that in `.claude/launch.json`
(`runtimeExecutable: "bash"`, `runtimeArgs: ["-lc", "cd … && DATABASE_URL=… npm run dev -- -p 3010"]`,
`port: 3010`) and use the preview tools, so the user gets the browser pane.

## 4. Browse signed in

Set the session cookie **before the first page load**, then navigate:

```js
document.cookie = "authjs.session-token=dev-admin-session-token; path=/"
```

Then visit `/admin` (or anywhere). Swap tokens for the member.

**The one gotcha:** after the first server response, the app re-sets that
cookie **HttpOnly** (the proxy's session-rotation behavior), and from then on
`document.cookie` writes to it are silently ignored — you cannot switch
identities from page JS. To probe as a different identity, use curl with an
explicit header instead; it also gives clean status codes:

```bash
curl -s -w '\nHTTP %{http_code}\n' -H 'Cookie: authjs.session-token=dev-member-session-token' http://localhost:3010/admin
```

Expected shape of the admin surface (useful smoke): anonymous `/admin` → 307 to
sign-in; member `/admin` and `/admin/x/<anything>` → 307 to `/`; admin
`/admin/x/<unknown>` → 404; `/api/admin/x/<anything>` → 403 anonymous/member,
404 admin when no integration is installed.

## 5. Teardown

Stop the dev server (or `preview_stop`), then:

```bash
docker rm -f yo-dev-pg
```

Everything created by this skill is gone with the container.
