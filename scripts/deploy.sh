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

# 3. Build a Production deployment without assigning the Production domain. The remote
#    `vercel-build` command compiles first and then applies the journal. Nothing user-facing
#    changes until the exact staged deployment passes its deep health check below.
echo "▶ vercel --prod --skip-domain (this checkout's tree → staged $PROJECT deployment)…"
DEPLOYMENT_URL=$(vercel --prod --skip-domain --yes)

# 4. Verify the staged deployment before promotion. A failed check leaves the current
#    Production deployment in place; expand/contract keeps it compatible with the schema
#    the successful migration just applied.
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$DEPLOYMENT_URL/api/health" || echo "000")
echo "▶ ${DEPLOYMENT_URL}/api/health → ${CODE}"
[ "$CODE" = "200" ] || { echo "✗ health check failed (${CODE})" >&2; exit 1; }

# 5. Promotion only reassigns the Production domain; it does not rebuild.
echo "▶ promoting $DEPLOYMENT_URL → Production…"
vercel promote "$DEPLOYMENT_URL" --yes

# 6. Verify the production alias too, so a domain-assignment problem is visible.
URL="https://${PROJECT}.vercel.app"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$URL/api/health" || echo "000")
echo "▶ ${URL}/api/health → ${CODE}"
[ "$CODE" = "200" ] || { echo "✗ promoted deployment is unhealthy (${CODE})" >&2; exit 1; }
echo "✓ deployed & healthy: $URL"
