#!/usr/bin/env bash
#
# Apply the drizzle/ journal to a deployment's database, as a DEPLOY STEP.
#
# Why this exists rather than letting instrumentation.ts do it at boot: boot
# migrations only complete where the runtime keeps the process alive with CPU
# until register() resolves. That holds for a long-lived server (a VM, a
# container on a host, Kubernetes) and does NOT hold for per-invocation
# runtimes (Vercel Functions, Lambda) or container platforms that throttle CPU
# between requests (Cloud Run, Container Apps, Fargate scaled to zero). There,
# the response returns while the migration is still running, the instance is
# frozen, and the journal never lands — the app then serves 503 forever via
# migrationGateError(). Running the journal HERE puts it on a step that is
# allowed to take as long as it takes, on any platform.
#
# Serving instances should therefore set RUN_MIGRATIONS_ON_BOOT=0.
#
#   npm run migrate:deploy                  # resolves the DB from the linked Vercel project
#   DATABASE_URL=postgres://… npm run migrate:deploy      # or point it explicitly
#   VERCEL_ENV_TARGET=preview npm run migrate:deploy      # staging/preview instead of production
#
# ORDERING: run this BEFORE shipping the new code, so the schema is ready when
# the new version boots. That is safe for additive migrations. A migration that
# REMOVES something the currently-live version still reads (0014 drops
# users.slug) breaks the old version for the length of the deploy — plan a
# window for those rather than discovering it in production.
set -euo pipefail

cd "$(dirname "$0")/.."
export PATH="$HOME/.npm-global/bin:$PATH"

TARGET_ENV="${VERCEL_ENV_TARGET:-production}"
PULLED=""

cleanup() { [ -n "$PULLED" ] && rm -f "$PULLED"; }
trap cleanup EXIT

if [ -z "${DATABASE_URL:-}" ]; then
  # No explicit URL: take the one the deployment itself uses, so we can never
  # migrate a different database than the code will talk to.
  if [ ! -f .vercel/project.json ]; then
    echo "✗ No DATABASE_URL set and this checkout is not linked to a Vercel project." >&2
    echo "  Either:  DATABASE_URL=postgres://… npm run migrate:deploy" >&2
    echo "  or:      vercel link --project <name> --yes" >&2
    exit 1
  fi
  PROJECT=$(node -p "require('./.vercel/project.json').projectName")
  echo "▶ Reading ${TARGET_ENV} DATABASE_URL from Vercel project: ${PROJECT}"
  PULLED=$(mktemp)
  # --non-interactive so this never blocks a CI run waiting on a prompt.
  vercel env pull "$PULLED" --environment="$TARGET_ENV" --non-interactive >/dev/null 2>&1 || {
    echo "✗ vercel env pull failed for environment '${TARGET_ENV}'." >&2
    exit 1
  }
  DATABASE_URL=$(node -e '
    const fs = require("fs");
    for (const line of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
      const m = line.match(/^(?:export\s+)?DATABASE_URL="?([^"]*)"?\s*$/);
      if (m) { process.stdout.write(m[1]); break; }
    }
  ' "$PULLED")
  [ -n "$DATABASE_URL" ] || { echo "✗ No DATABASE_URL in the ${TARGET_ENV} environment." >&2; exit 1; }
  export DATABASE_URL
fi

# Say which database, without printing credentials.
HOST=$(node -e 'try{const u=new URL(process.env.DATABASE_URL);process.stdout.write(u.host+u.pathname)}catch{process.stdout.write("(unparseable)")}')
echo "▶ Target database: ${HOST}"

# Report what is pending before touching anything, so the log says what changed.
node -e '
const fs = require("fs");
const j = JSON.parse(fs.readFileSync("drizzle/meta/_journal.json", "utf8"));
console.log("▶ Journal in this tree: " + j.entries.length + " entries (latest: " + j.entries[j.entries.length-1].tag + ")");
'

echo "▶ Applying the journal…"
npx tsx scripts/run-boot-migrations.ts

echo "✓ schema is current on ${HOST}"
