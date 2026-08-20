#!/usr/bin/env bash
#
# Deploy the hosted app to Vercel — the ONE command. Run `npm run deploy`.
#
# WHICH project is deployed is controlled by .vercel/project.json (gitignored,
# per-checkout) — the standard Vercel link. So each person/instance targets a
# different project with nothing committed:
#     vercel link --project <name> --yes      # once, e.g. mtoyyo-worldcup / malloyyo
#     npm run deploy                           # deploys whatever this checkout is linked to
#
# This script encodes the whole procedure. (The engine's dist/ is gitignored;
# the root `build` script now builds it remotely too, so git-based deploys
# work — the local pre-build here just keeps the uploaded tree self-contained
# either way.) Don't re-derive the steps — just run it.
set -euo pipefail

cd "$(dirname "$0")/.."                      # repo root
export PATH="$HOME/.npm-global/bin:$PATH"    # the vercel CLI lives here

# 1. Must be linked — the gitignored link decides the target project.
if [ ! -f .vercel/project.json ]; then
  echo "✗ Not linked to a Vercel project." >&2
  echo "  Run:  vercel link --project <name> --yes   (e.g. mtoyyo-worldcup)" >&2
  exit 1
fi
PROJECT=$(node -p "require('./.vercel/project.json').projectName")
echo "▶ Target Vercel project: $PROJECT"

# 2. Build the engine dist FIRST (gitignored; the remote build won't make it).
echo "▶ Building @malloyyo/mcp-engine…"
( cd packages/mcp-engine && npm run build >/dev/null )

# 3. Apply the drizzle/ journal BEFORE the new code is live, so it boots onto a
#    current schema. This is a deploy step rather than a boot step because boot
#    migrations cannot complete on a per-invocation runtime — the instance is
#    frozen mid-migration and the app then serves 503 forever. See
#    scripts/migrate-deploy.sh. Serving instances set RUN_MIGRATIONS_ON_BOOT=0.
#
#    Safe for additive migrations. One that REMOVES something the currently-live
#    version still reads breaks it for the length of the deploy — check the
#    pending entries and plan a window before running this.
#    SKIP_MIGRATIONS=1 to deploy without touching the schema.
if [ "${SKIP_MIGRATIONS:-0}" = "1" ]; then
  echo "▶ SKIP_MIGRATIONS=1 — not applying the journal"
else
  echo "▶ Applying the migration journal to $PROJECT's database…"
  bash scripts/migrate-deploy.sh
fi

# 4. Deploy. `vercel --prod` builds remotely using the project's own env vars and
#    uploads this working tree (incl. the engine dist we just built).
echo "▶ vercel --prod (this checkout's tree → $PROJECT)…"
vercel --prod --yes

# 5. Verify the production alias is healthy.
URL="https://${PROJECT}.vercel.app"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$URL/api/health" || echo "000")
echo "▶ ${URL}/api/health → ${CODE}"
[ "$CODE" = "200" ] || { echo "✗ health check failed (${CODE})" >&2; exit 1; }
echo "✓ deployed & healthy: $URL"
