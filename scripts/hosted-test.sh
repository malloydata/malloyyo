#!/usr/bin/env bash
# Copyright (c) The Malloy Foundation
# SPDX-License-Identifier: MIT
#
# Stand up a Postgres, apply the schema, and run the DB-backed integration
# tests against it: the hosted-explore surface (test/hosted-explore.test.ts)
# and the CLI publish flow (test/publish-flow.test.ts). Postgres is the only
# external dep — the Malloy models run on in-process DuckDB.
#
#   npm run test:hosted
#
# THIS SCRIPT IS DESTRUCTIVE. It drops and recreates the `public` schema before
# each test file, so every run starts from a known-empty database and re-runs
# can't trip over the last run's rows. Never point it at a database you care
# about — see "external" below for the guards that try to stop you.
#
# WHERE THE DATABASE COMES FROM, in order:
#
#   1. external  — $YO_TEST_DATABASE_URL, if set. Deliberately NOT the ambient
#                  $DATABASE_URL: that one usually points at a dev/staging
#                  branch, and this script would wipe it. Refuses a non-local
#                  host, and refuses a database that already has rows, unless
#                  YO_TEST_FORCE=1.
#   2. docker    — an ephemeral postgres:16-alpine container, created fresh and
#                  removed on exit. The default when a daemon is running (and
#                  what CI uses: preflight.yml on ubuntu-latest).
#   3. local     — initdb/pg_ctl from a locally installed Postgres, in a temp
#                  data dir that's torn down on exit. Makes the suite runnable
#                  in Docker-less environments (agent sandboxes, macOS runners).
#
# Other knobs: PG_TEST_PORT, PG_TEST_CONTAINER, YO_TEST_SKIP_CLI_BUILD=1
# (the publish test runs the built CLI; skip the rebuild if yours is current),
# YO_TEST_BACKEND=external|docker|local to force one instead of autodetecting.
set -euo pipefail
cd "$(dirname "$0")/.."

CONTAINER="${PG_TEST_CONTAINER:-yo-hosted-test-pg}"
PORT="${PG_TEST_PORT:-55432}"
MODE=""
PG_RUN_DIR=""
PGDATA_DIR=""
PG_BIN=""
PG_AS="bash -c"
# How to talk to the database. Set once the backend is up: the host `psql` when
# there is one, else the container's (a Mac with Docker often has no client).
PSQL=()

# ── pick a backend ───────────────────────────────────────────────────────────

have_docker() { docker info >/dev/null 2>&1; }

# initdb/pg_ctl aren't on PATH in a Debian/Homebrew install — find them.
find_pg_bin() {
  local d
  if command -v initdb >/dev/null 2>&1 && command -v pg_ctl >/dev/null 2>&1; then
    dirname "$(command -v initdb)"
    return 0
  fi
  for d in /usr/lib/postgresql/*/bin /opt/homebrew/opt/postgresql@*/bin \
           /usr/local/opt/postgresql@*/bin /opt/homebrew/bin /usr/pgsql-*/bin; do
    [ -x "$d/initdb" ] && [ -x "$d/pg_ctl" ] && { echo "$d"; return 0; }
  done
  return 1
}

if [ -n "${YO_TEST_BACKEND:-}" ]; then
  MODE="$YO_TEST_BACKEND"
elif [ -n "${YO_TEST_DATABASE_URL:-}" ]; then
  MODE="external"
elif have_docker; then
  MODE="docker"
elif find_pg_bin >/dev/null; then
  MODE="local"
else
  cat >&2 <<'MSG'
✗ No Postgres available.
  Start Docker, install Postgres (initdb/pg_ctl on PATH), or point
  YO_TEST_DATABASE_URL at a THROWAWAY database — this script wipes it.
MSG
  exit 1
fi

# ── bring it up ──────────────────────────────────────────────────────────────

cleanup() {
  case "$MODE" in
    docker) docker rm -f "$CONTAINER" >/dev/null 2>&1 || true ;;
    local)
      if [ -n "$PG_RUN_DIR" ]; then
        [ -n "$PG_BIN" ] && $PG_AS "$PG_BIN/pg_ctl -D $PGDATA_DIR -m immediate stop" >/dev/null 2>&1 || true
        rm -rf "$PG_RUN_DIR"
      fi
      ;;
  esac
}
trap cleanup EXIT

# Wait over TCP, not the unix socket: the postgres image (and initdb) run a
# THROWAWAY server on the socket only while initializing, so a socket-based
# check passes on that one and the next command hits "system is shutting down".
wait_for_pg() {
  local streak=0
  for _ in $(seq 1 120); do
    if "${PSQL[@]}" -c 'select 1' >/dev/null 2>&1; then
      streak=$((streak + 1))
      [ "$streak" -ge 2 ] && return 0
    else
      streak=0
    fi
    sleep 0.5
  done
  return 1
}

case "$MODE" in
  external)
    export DATABASE_URL="${YO_TEST_DATABASE_URL:?YO_TEST_BACKEND=external needs YO_TEST_DATABASE_URL}"
    EXTERNAL_HOST=$(node -e 'process.stdout.write(new URL(process.argv[1]).hostname)' "$DATABASE_URL")
    if [ "${YO_TEST_FORCE:-}" != "1" ]; then
      case "$EXTERNAL_HOST" in
        localhost|127.0.0.1|::1|host.docker.internal) ;;
        *)
          echo "✗ refusing to wipe a non-local database ($EXTERNAL_HOST). Set YO_TEST_FORCE=1 if you're sure." >&2
          exit 1
          ;;
      esac
    fi
    echo "→ using YO_TEST_DATABASE_URL (host: $EXTERNAL_HOST)"
    ;;

  docker)
    have_docker || { echo "✗ YO_TEST_BACKEND=docker but no Docker daemon is running" >&2; exit 1; }
    export DATABASE_URL="postgres://postgres:test@127.0.0.1:${PORT}/postgres"
    cleanup # clear any stale container from a previous aborted run
    echo "→ starting Postgres in Docker ($CONTAINER on :$PORT)"
    docker run -d --name "$CONTAINER" \
      -e POSTGRES_PASSWORD=test -e POSTGRES_DB=postgres \
      -p "${PORT}:5432" postgres:16-alpine >/dev/null
    ;;

  local)
    PG_BIN=$(find_pg_bin) || { echo "✗ YO_TEST_BACKEND=local but no initdb/pg_ctl found" >&2; exit 1; }
    # The logs live NEXT TO the data dir, not in it: initdb refuses a non-empty
    # PGDATA, and a log file written there first is exactly that.
    PG_RUN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/yo-hosted-pg.XXXXXX")
    PGDATA_DIR="$PG_RUN_DIR/data"
    mkdir -p "$PGDATA_DIR"
    PGUSER_NAME="${USER:-$(id -un)}"
    # Postgres refuses to run as root — common in agent/CI sandboxes. Drop to the
    # `postgres` system account there (and hand it the run dir).
    if [ "$(id -u)" = "0" ] && id postgres >/dev/null 2>&1; then
      chown -R postgres "$PG_RUN_DIR"
      PG_AS="su postgres -c"
      PGUSER_NAME="postgres"
    fi
    # initdb always creates a `postgres` database, whoever the bootstrap user is.
    export DATABASE_URL="postgres://${PGUSER_NAME}@127.0.0.1:${PORT}/postgres"
    echo "→ starting Postgres from $PG_BIN (port $PORT, data in $PGDATA_DIR)"
    $PG_AS "$PG_BIN/initdb -D $PGDATA_DIR -U $PGUSER_NAME --auth=trust" >"$PG_RUN_DIR/initdb.log" 2>&1 ||
      { echo "✗ initdb failed:"; cat "$PG_RUN_DIR/initdb.log"; exit 1; }
    $PG_AS "$PG_BIN/pg_ctl -D $PGDATA_DIR -o '-p $PORT -c listen_addresses=127.0.0.1' -l $PG_RUN_DIR/server.log start" >/dev/null
    ;;

  *) echo "✗ unknown YO_TEST_BACKEND: $MODE" >&2; exit 1 ;;
esac

# Resolve how we run psql, now that DATABASE_URL is known.
if command -v psql >/dev/null 2>&1; then
  PSQL=(psql "$DATABASE_URL")
elif [ -n "$PG_BIN" ] && [ -x "$PG_BIN/psql" ]; then
  PSQL=("$PG_BIN/psql" "$DATABASE_URL")
elif [ "$MODE" = "docker" ]; then
  PSQL=(docker exec -i "$CONTAINER" psql -U postgres -d postgres)
else
  echo "✗ no psql client found — install the Postgres client tools" >&2
  exit 1
fi

# The other half of the external guard, now that we know how to run psql: rows
# present ⇒ this is somebody's real database, not a scratch one.
if [ "$MODE" = "external" ] && [ "${YO_TEST_FORCE:-}" != "1" ]; then
  rows=$("${PSQL[@]}" -tAc \
    "select coalesce((select count(*) from users), 0) + coalesce((select count(*) from datasets), 0)" \
    2>/dev/null || echo 0)
  rows=$(echo "$rows" | tr -d '[:space:]')
  if [ -n "$rows" ] && [ "$rows" != "0" ]; then
    echo "✗ that database already has $rows user/dataset row(s) — this script drops the schema." >&2
    echo "  Use an empty database, or set YO_TEST_FORCE=1 if you're sure." >&2
    exit 1
  fi
fi

echo "→ waiting for Postgres to accept connections"
wait_for_pg || {
  echo "✗ Postgres did not become ready${PG_RUN_DIR:+ (see $PG_RUN_DIR/server.log)}"
  exit 1
}

# ── schema ───────────────────────────────────────────────────────────────────

# `push` is interactive (a confirm prompt even for pure creates). `export` dumps
# the full DDL (diff from empty) to stdout — non-interactive. Generated once and
# replayed before each test file so every file starts from an empty database.
echo "→ generating schema DDL (drizzle-kit export)"
SCHEMA_SQL=$(npx drizzle-kit export 2>/dev/null)
[ -n "$SCHEMA_SQL" ] || { echo "✗ drizzle-kit export produced nothing"; exit 1; }

reset_schema() {
  "${PSQL[@]}" -q -v ON_ERROR_STOP=1 \
    -c 'drop schema if exists public cascade' -c 'create schema public' >/dev/null
  printf '%s\n' "$SCHEMA_SQL" | "${PSQL[@]}" -q -v ON_ERROR_STOP=1 >/dev/null
}

# ── tests ────────────────────────────────────────────────────────────────────

echo "→ running client-profile unit test (no DB)"
npx tsx --test test/client-profile.test.ts

echo "→ running hosted-explore test"
reset_schema
npx tsx --test test/hosted-explore.test.ts

# The publish test drives the REAL CLI binary, so build it (this also builds the
# mcp-engine the CLI bundles against).
if [ "${YO_TEST_SKIP_CLI_BUILD:-}" = "1" ]; then
  echo "→ skipping CLI build (YO_TEST_SKIP_CLI_BUILD=1)"
else
  echo "→ building the malloyyo CLI"
  npm run build -w packages/cli >/dev/null
fi

echo "→ running publish-flow test"
reset_schema
npx tsx --test test/publish-flow.test.ts
