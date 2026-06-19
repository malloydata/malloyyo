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
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 0.5
done
[ "${ready:-}" = 1 ] || { echo "Postgres did not become ready"; exit 1; }

echo "→ applying schema (drizzle-kit export | psql)"
# `push` is interactive (a confirm prompt even for pure creates). `export` dumps
# the full DDL (diff from empty) to stdout — non-interactive — which we pipe
# straight into the fresh DB.
npx drizzle-kit export 2>/dev/null | docker exec -i "$CONTAINER" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1

echo "→ running hosted-explore test"
npx tsx --test test/hosted-explore.test.ts
