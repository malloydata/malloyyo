#!/usr/bin/env bash
# Copyright (c) The Malloy Foundation
# SPDX-License-Identifier: MIT
#
# Stand up an ephemeral Postgres, push the schema, and run the hosted-explore
# integration test against it (test/hosted-explore.test.ts). Postgres is the
# only external dep — the Malloy model runs on in-process DuckDB. Hermetic: the
# container is created fresh and torn down on exit.
#
#   npm run test:hosted
set -euo pipefail
cd "$(dirname "$0")/.."

CONTAINER="${PG_TEST_CONTAINER:-yo-hosted-test-pg}"
PORT="${PG_TEST_PORT:-55432}"
export DATABASE_URL="postgres://postgres:test@localhost:${PORT}/postgres"

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup  # clear any stale container from a previous aborted run

echo "→ starting Postgres ($CONTAINER on :$PORT)"
docker run -d --name "$CONTAINER" \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=postgres \
  -p "${PORT}:5432" postgres:16-alpine >/dev/null

echo "→ waiting for Postgres to accept connections"
# The postgres image starts a THROWAWAY server to run init, then shuts it down
# and restarts the real one. The init server listens ONLY on the unix socket
# (listen_addresses=''), so a socket-based check — `pg_isready -U postgres` or a
# `SELECT 1` over the socket — passes on it prematurely, and the schema apply
# below then hits the "database system is shutting down" window. Check over TCP
# (`-h 127.0.0.1`) instead: the init server isn't listening on TCP, so this only
# succeeds on the final server. Require a couple in a row for good measure.
streak=0
for _ in $(seq 1 120); do
  if docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres -d postgres >/dev/null 2>&1; then
    streak=$((streak + 1))
    if [ "$streak" -ge 3 ]; then ready=1; break; fi
  else
    streak=0
  fi
  sleep 0.5
done
[ "${ready:-}" = 1 ] || { echo "Postgres did not become ready"; exit 1; }

echo "→ applying schema (drizzle-kit export | psql)"
# `push` is interactive (a confirm prompt even for pure creates). `export` dumps
# the full DDL (diff from empty) to stdout — non-interactive — which we pipe
# straight into the fresh DB.
npx drizzle-kit export 2>/dev/null | docker exec -i "$CONTAINER" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1

echo "→ running client-profile unit test (no DB)"
npx tsx --test test/client-profile.test.ts

echo "→ running hosted-explore test"
npx tsx --test test/hosted-explore.test.ts
