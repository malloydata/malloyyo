#!/usr/bin/env bash
# Copyright (c) The Malloy Foundation
# SPDX-License-Identifier: MIT
#
# The migration journal, verified against a real Postgres. Stands up an
# ephemeral container (its own name/port — never collides with the hosted-test
# or run-dev containers) and proves the claims the boot path depends on:
#
#   1. PARITY      — replaying the whole journal on an empty database produces
#                    exactly the schema `drizzle-kit export` (src/db/schema.ts)
#                    describes. This is what licenses 0012_push_catchup to call
#                    itself the complete push archaeology.
#   2. CONVERGE    — a pre-journal database at the CURRENT schema (a self-hosted
#                    instance initialized by the retired ensureSchema, or kept
#                    current by hand-running the manual files) is baselined at
#                    0000, converges to parity, and its data survives: 0003
#                    must not touch new-shape favorites, and 0004 must not
#                    re-backport from leftover July-2026 *_bak backups —
#                    favorites deleted since stay deleted.
#   3. ARCHAEOLOGY — a pre-journal database at the May-2026 vintage (journal
#                    0000 plus the push-era conversations/inquiries/tool_calls
#                    and old favorites) upgrades through the whole folded chain:
#                    slugs backfilled (0001), redesign (0003), favorites
#                    backported (0004), catch-up (0012) — ending at parity.
#   4. CONCURRENT  — two boots migrating the same fresh database at once (warm
#                    + spare Machine) both succeed and record each migration
#                    exactly once. Drizzle's migrator does NOT serialize itself
#                    (it reads the applied set outside its transaction); the
#                    advisory lock in src/lib/migrate.ts is what this pins.
#   5. READINESS   — the real standalone server (which also proves ./drizzle is
#                    traced into the bundle): a database that makes a migration
#                    fail (duplicate ready dataset names vs 0009's unique
#                    index) boots to a 503 /api/health; fixing the data and
#                    rebooting yields 200.
#
# Needs: Docker, and `npm run build` first (step 5 runs .next/standalone).
#   npm run test:migrate
set -euo pipefail
cd "$(dirname "$0")/.."

CONTAINER="${PG_MIGRATE_TEST_CONTAINER:-yo-migrate-test-pg}"
PORT="${PG_MIGRATE_TEST_PORT:-55434}"
APP_PORT="${MIGRATE_TEST_APP_PORT:-3111}"
URL_BASE="postgres://postgres:test@localhost:${PORT}"

SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" >/dev/null 2>&1 || true
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

# The standalone root nests under the project's path relative to the inferred
# workspace root (flat in a normal checkout, nested when built from a git
# worktree inside the repo) — locate server.js rather than assuming.
SERVER_JS="$(find .next/standalone -name server.js -not -path '*node_modules*' 2>/dev/null | head -1)"
if [ -z "$SERVER_JS" ]; then
  echo "✗ .next/standalone/server.js missing — run 'npm run build' first (step 5 boots the real server)" >&2
  exit 1
fi
APP_DIR="$(dirname "$SERVER_JS")"

echo "→ starting Postgres ($CONTAINER on :$PORT)"
docker run -d --name "$CONTAINER" \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=postgres \
  -p "${PORT}:5432" postgres:16-alpine >/dev/null

# TCP check, three in a row — the image's init server only listens on the unix
# socket, so a socket check passes prematurely (see scripts/hosted-test.sh).
streak=0
for _ in $(seq 1 120); do
  if docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres -d postgres >/dev/null 2>&1; then
    streak=$((streak + 1)); [ "$streak" -ge 3 ] && { ready=1; break; }
  else
    streak=0
  fi
  sleep 0.5
done
[ "${ready:-}" = 1 ] || { echo "Postgres did not become ready"; exit 1; }

psql_db() { # psql_db <db> [args...]
  local db="$1"; shift
  docker exec -i "$CONTAINER" psql -U postgres -d "$db" -q -v ON_ERROR_STOP=1 "$@"
}
newdb() { docker exec "$CONTAINER" createdb -U postgres "$1"; }

# Order-insensitive schema fingerprint: columns, constraints, indexes, enums.
# Physical column order differs by construction path (an upgraded table appends
# columns; a fresh CREATE interleaves them) and is invisible to the app, so it
# is deliberately not part of the fingerprint. *_bak tables are 0003's
# disposable safety net and are excluded.
fingerprint() { # fingerprint <db>
  psql_db "$1" -At <<'SQL'
SELECT 'column: ' || table_name || '.' || column_name || ' type=' || data_type
       || ' null=' || is_nullable || ' default=' || COALESCE(column_default, '-')
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name NOT LIKE '%\_bak'
ORDER BY 1;
SELECT 'constraint: ' || conrelid::regclass || '.' || conname || ' ' || pg_get_constraintdef(oid)
FROM pg_constraint
WHERE connamespace = 'public'::regnamespace AND conrelid <> 0
  AND conrelid::regclass::text NOT LIKE '%\_bak'
ORDER BY 1;
SELECT 'index: ' || indexdef FROM pg_indexes
WHERE schemaname = 'public' AND tablename NOT LIKE '%\_bak'
ORDER BY 1;
SELECT 'enum: ' || t.typname || '=' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
WHERE t.typnamespace = 'public'::regnamespace
GROUP BY t.typname ORDER BY 1;
SQL
}

count_migrations() { psql_db "$1" -At -c "SELECT count(*) FROM drizzle.__drizzle_migrations"; }

boot() { # boot <db>  — the boot migration path, as a process
  DATABASE_URL="${URL_BASE}/$1" npx tsx scripts/run-boot-migrations.ts
}

fail() { echo "✗ $*" >&2; exit 1; }

# Every journal entry must end up applied. Derived, not hardcoded: a new
# migration lands as one more journal entry and this suite keeps asserting
# "all of them" without anyone remembering to bump a count.
JOURNAL_ENTRIES=$(python3 -c "import json; print(len(json.load(open('drizzle/meta/_journal.json'))['entries']))")

# Build a database at the LAST HAND-RUN VINTAGE (entry 0012, where journal
# adoption ended the manual era) by replaying the journal's own files. This is
# what a real pre-journal database can be at, at most — newer entries are plain
# generated SQL that only ever runs through the migrator, so simulating a
# pre-journal database from the current export would fabricate an impossible
# vintage and re-run non-idempotent entries over their own objects.
apply_prejournal_vintage() { # apply_prejournal_vintage <db>
  python3 -c "
import json
entries = json.load(open('drizzle/meta/_journal.json'))['entries']
print('\n'.join('drizzle/' + e['tag'] + '.sql' for e in entries if e['idx'] <= 12))
" | while read -r f; do psql_db "$1" < "$f"; done
}

# --- 1. PARITY -------------------------------------------------------------
echo "→ [1/5] parity: journal replay vs drizzle-kit export"
newdb journal_fresh
boot journal_fresh >/dev/null
newdb export_ref
npx drizzle-kit export 2>/dev/null | psql_db export_ref
fingerprint journal_fresh > /tmp/migrate-test-journal.txt
fingerprint export_ref    > /tmp/migrate-test-export.txt
diff -u /tmp/migrate-test-export.txt /tmp/migrate-test-journal.txt \
  || fail "journal replay does not reproduce src/db/schema.ts (diff above; < export, > journal)"
[ "$(count_migrations journal_fresh)" = "$JOURNAL_ENTRIES" ] || fail "expected $JOURNAL_ENTRIES applied migrations"
boot journal_fresh >/dev/null   # second boot: everything applied, nothing re-runs
[ "$(count_migrations journal_fresh)" = "$JOURNAL_ENTRIES" ] || fail "re-boot re-applied migrations"
echo "✓ parity (and re-boot is a no-op)"

# --- 2. CONVERGE -----------------------------------------------------------
# The pre-journal vintage is FIXED at entry 0012 — journal adoption ended the
# hand-run era there, so no real pre-journal database can hold anything later
# (newer entries are plain generated SQL and only ever run through the
# migrator, exactly once). Build the fixture by replaying the journal's own
# files through 0012; the boot then converges it the rest of the way.
echo "→ [2/5] converge: pre-journal database at the last hand-run vintage (0012)"
newdb prejournal
apply_prejournal_vintage prejournal
psql_db prejournal <<'SQL'
WITH u AS (INSERT INTO users (slug) VALUES ('u1') RETURNING id),
     d AS (INSERT INTO datasets (user_id, name, status) SELECT id, 'ds', 'ready' FROM u RETURNING id),
     q AS (INSERT INTO saved_queries (dataset_id, user_id, question, malloy_source)
           SELECT d.id, u.id, 'q?', 'run: x' FROM d, u RETURNING id)
INSERT INTO favorites (user_id, saved_query_id) SELECT u.id, q.id FROM u, q;
-- Leftovers of a hand-run July-2026 redesign (0003/0004 applied via psql, the
-- *_bak safety nets never dropped), including a favorite the user has DELETED
-- since: 0004 must not resurrect it from the backups on the journal-adoption
-- boot. This is the normal long-running self-hosted instance, not an edge.
CREATE TABLE inquiries_bak (id uuid DEFAULT gen_random_uuid(), slug text, question text, created_at timestamptz DEFAULT now());
CREATE TABLE tool_calls_bak (inquiry_id uuid, dataset_id uuid, user_id uuid, tool_name text, source text, malloy_input text, compiled_sql text, error text, created_at timestamptz DEFAULT now());
CREATE TABLE favorites_bak (user_id uuid, inquiry_id uuid, created_at timestamptz DEFAULT now());
WITH i AS (INSERT INTO inquiries_bak (slug, question) VALUES ('main_deadbeef1', 'deleted since?') RETURNING id),
     t AS (INSERT INTO tool_calls_bak (inquiry_id, dataset_id, user_id, tool_name, malloy_input, compiled_sql)
           SELECT i.id, d.id, u.id, 'run_query', 'run: y', 'SELECT 2' FROM i, datasets d, users u RETURNING inquiry_id)
INSERT INTO favorites_bak (user_id, inquiry_id) SELECT u.id, t.inquiry_id FROM users u, t;
SQL
boot prejournal >/dev/null
fingerprint prejournal > /tmp/migrate-test-prejournal.txt
diff -u /tmp/migrate-test-export.txt /tmp/migrate-test-prejournal.txt \
  || fail "pre-journal database did not converge to the current schema"
[ "$(count_migrations prejournal)" = "$JOURNAL_ENTRIES" ] || fail "expected 0000 baselined + the rest applied"
[ "$(psql_db prejournal -At -c 'SELECT count(*) FROM favorites')" = "1" ] \
  || fail "0003 touched new-shape favorites on an already-current database"
[ "$(psql_db prejournal -At -c 'SELECT count(*) FROM saved_queries')" = "1" ] \
  || fail "0004 re-backported from leftover *_bak tables on an already-current database"
echo "✓ converge (favorites survived; leftover *_bak backups left alone)"

# --- 3. ARCHAEOLOGY --------------------------------------------------------
echo "→ [3/5] archaeology: May-2026 vintage upgrades through the folded chain"
newdb midvintage
psql_db midvintage < drizzle/0000_handy_malcolm_colcord.sql
psql_db midvintage <<'SQL'
-- The push-era tables 0001-0004 operate on, at their pre-0001 shape (no slug
-- column yet), with a favorited inquiry whose tool_call still carries the
-- pre-rename tool name.
CREATE TABLE conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE inquiries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), question text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE tool_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inquiry_id uuid, dataset_id uuid, user_id uuid,
  tool_name text NOT NULL, source text, malloy_input text, compiled_sql text, error text,
  created_at timestamptz NOT NULL DEFAULT now());
DROP TABLE IF EXISTS favorites;  -- replace 0000-era favorites with the old inquiry-keyed shape
CREATE TABLE favorites (user_id uuid NOT NULL, inquiry_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
WITH u AS (INSERT INTO users (slug) VALUES ('u1') RETURNING id),
     d AS (INSERT INTO datasets (user_id, name, source_url, md_table, status)
           SELECT id, 'ds', 'http://x', 't', 'ready' FROM u RETURNING id),
     i AS (INSERT INTO inquiries (question) VALUES ('favorite me?') RETURNING id),
     t AS (INSERT INTO tool_calls (inquiry_id, dataset_id, user_id, tool_name, source, malloy_input, compiled_sql)
           SELECT i.id, d.id, u.id, 'run_analytical_query', 'src', 'run: x', 'SELECT 1' FROM i, d, u RETURNING id)
INSERT INTO favorites (user_id, inquiry_id) SELECT u.id, i.id FROM u, i;
SQL
boot midvintage >/dev/null
fingerprint midvintage > /tmp/migrate-test-midvintage.txt
diff -u /tmp/migrate-test-export.txt /tmp/migrate-test-midvintage.txt \
  || fail "mid-vintage database did not converge to the current schema"
[ "$(psql_db midvintage -At -c 'SELECT count(*) FROM saved_queries WHERE question = $$favorite me?$$')" = "1" ] \
  || fail "0004 did not backport the favorited inquiry into saved_queries"
[ "$(psql_db midvintage -At -c 'SELECT count(*) FROM favorites f JOIN saved_queries q ON q.id = f.saved_query_id')" = "1" ] \
  || fail "0004 did not re-point the favorite at saved_queries"
echo "✓ archaeology (favorite backported through 0001→0004)"

# --- 4. CONCURRENT ---------------------------------------------------------
echo "→ [4/5] concurrent: two boots on one fresh database"
for i in 1 2 3; do
  db="concurrent$i"
  newdb "$db"
  boot "$db" >/dev/null & P1=$!
  boot "$db" >/dev/null & P2=$!
  wait "$P1" || fail "concurrent boot A failed (iteration $i)"
  wait "$P2" || fail "concurrent boot B failed (iteration $i)"
  [ "$(count_migrations "$db")" = "$JOURNAL_ENTRIES" ] \
    || fail "concurrent boots recorded $(count_migrations "$db") rows, expected $JOURNAL_ENTRIES (iteration $i)"
done
fingerprint concurrent3 > /tmp/migrate-test-concurrent.txt
diff -u /tmp/migrate-test-export.txt /tmp/migrate-test-concurrent.txt \
  || fail "concurrent boots did not converge to the current schema"
echo "✓ concurrent (3 iterations, serialized by the advisory lock)"

# --- 5. READINESS ----------------------------------------------------------
echo "→ [5/5] readiness: real standalone server, failed migration → health 503"
[ -f "$APP_DIR/drizzle/meta/_journal.json" ] \
  || fail ".next/standalone is missing drizzle/ — outputFileTracingIncludes regression"

newdb unready
apply_prejournal_vintage unready
# Make 0009's unique index impossible: two ready datasets sharing a name, and
# no journal — the realistic self-hosted upgrade failure this entry documents.
psql_db unready <<'SQL'
DROP INDEX datasets_name_ready_unique;
WITH u AS (INSERT INTO users (slug) VALUES ('u1') RETURNING id)
INSERT INTO datasets (user_id, name, status)
SELECT id, 'dup', 'ready'::dataset_status FROM u UNION ALL SELECT id, 'dup', 'ready'::dataset_status FROM u;
SQL

# Deliberately NO RUN_MIGRATIONS_ON_BOOT here: boot migrations are on by
# default in production, and this pins exactly that — a production server with
# no flag must migrate, and must gate /api/health on the result.
start_server() {
  env NODE_ENV=production PORT="$APP_PORT" HOSTNAME=127.0.0.1 \
    DATABASE_URL="${URL_BASE}/unready" \
    APP_BASE_URL="http://127.0.0.1:${APP_PORT}" AUTH_SECRET=migrate-test-secret \
    node "$SERVER_JS" >/tmp/migrate-test-server.log 2>&1 &
  SERVER_PID=$!
}
health() { curl -s -o /tmp/migrate-test-health.json -w '%{http_code}' "http://127.0.0.1:${APP_PORT}/api/health" || true; }
wait_health() { # wait_health <expected-status>
  for _ in $(seq 1 60); do
    code="$(health)"
    [ "$code" = "$1" ] && return 0
    sleep 1
  done
  echo "--- server log ---" >&2; tail -30 /tmp/migrate-test-server.log >&2
  fail "expected /api/health $1, last saw '${code:-none}' (body: $(cat /tmp/migrate-test-health.json 2>/dev/null))"
}

start_server
wait_health 503
grep -q '"migrations":"failed"' /tmp/migrate-test-health.json \
  || fail "503 body does not report the failed migrations: $(cat /tmp/migrate-test-health.json)"
kill "$SERVER_PID"; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""
echo "  ✓ failed migration → 503"

# Fix the data, reboot: migrations complete and the instance reports ready.
psql_db unready -c "DELETE FROM datasets WHERE ctid IN (SELECT ctid FROM datasets WHERE name = 'dup' LIMIT 1)"
start_server
wait_health 200
grep -q '"status":"ok"' /tmp/migrate-test-health.json || fail "200 body is not ok: $(cat /tmp/migrate-test-health.json)"
[ "$(count_migrations unready)" = "$JOURNAL_ENTRIES" ] || fail "recovered boot did not complete the journal"
kill "$SERVER_PID"; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""
echo "  ✓ fixed data, re-boot → 200"

echo "✓ migrate-test: all green"
