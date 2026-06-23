#!/usr/bin/env bash
#
# preflight.sh — the paranoid "check everything before I push" command.
#
#   bash scripts/preflight.sh
#
# It changes nothing: it only *calls* the existing per-package scripts and fails
# loudly on the first problem. Green here means every offline-verifiable thing in
# the repo is good.
#
# WHAT IT RUNS (fail-fast, in order):
#   1. mcp-engine  — typecheck (src + test) and the full unit suite
#                    (node:test via tsx, real in-process DuckDB compiles).
#   2. cli         — typecheck, then `npm test` whose pretest BUILDS the bundle
#                    (which also rebuilds the engine) — so "the CLI builds and
#                    works" is proven, not assumed.
#   3. server      — eslint, `next build` (the real type/route check), and the
#                    hosted-explore integration test (test:hosted spins up an
#                    EPHEMERAL Docker Postgres + in-process DuckDB, hermetic).
#
# WHAT IT DOES NOT RUN — and why:
#   scripts/e2e.ts. It posts to the admin-gated /api/datasets with NO auth
#   header, needs a live server + a real Neon DATABASE_URL, and downloads a
#   ~50MB parquet over the network. None of that is reliably reproducible in an
#   offline gate, so folding it in would just make this command flaky-red. Run
#   it by hand against a live, signed-in instance when you actually want it:
#       APP_BASE_URL=<url> npm run e2e
#
# REQUIREMENTS: node + a running Docker daemon (for the hosted Postgres). The
# build step needs DATABASE_URL present (never connected to — db init is lazy);
# it uses $ENV_FILE if that file exists, else a throwaway placeholder.
set -uo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="${ENV_FILE:-local/fox}"

# --- presentation ----------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$'\e[1m'; DIM=$'\e[2m'; GREEN=$'\e[32m'; RED=$'\e[31m'; CYAN=$'\e[36m'; RESET=$'\e[0m'
else
  BOLD=''; DIM=''; GREEN=''; RED=''; CYAN=''; RESET=''
fi

STEP=0
started=$SECONDS
PASSED=()
FAILED=()
run() {  # run "label" cmd args...  — runs ALL steps, never stops early; the
         # summary at the end lists every failure so one red can't hide another.
  STEP=$((STEP + 1))
  local label="$1"; shift
  local t0=$SECONDS
  printf '\n%s━━ [%d] %s%s\n' "$BOLD$CYAN" "$STEP" "$label" "$RESET"
  printf '%s   $ %s%s\n' "$DIM" "$*" "$RESET"
  if "$@"; then
    printf '%s✓ %s%s  %s(%ds)%s\n' "$GREEN" "$label" "$RESET" "$DIM" "$((SECONDS - t0))" "$RESET"
    PASSED+=("$label")
  else
    printf '%s✗ %s%s  %s(%ds)%s\n' "$RED$BOLD" "$label" "$RESET" "$DIM" "$((SECONDS - t0))" "$RESET"
    FAILED+=("$label")
  fi
}

# --- preflight of the preflight: Docker is needed for test:hosted ----------
if ! docker info >/dev/null 2>&1; then
  printf '%s✗ Docker is not running.%s test:hosted needs an ephemeral Postgres.\n' "$RED$BOLD" "$RESET" >&2
  printf '  Start Docker Desktop and re-run.\n' >&2
  exit 1
fi

printf '%s🔎 preflight — paranoid full check%s\n' "$BOLD" "$RESET"

# --- 1. engine -------------------------------------------------------------
run "mcp-engine: typecheck"        npm --prefix packages/mcp-engine run typecheck
run "mcp-engine: unit tests"       npm --prefix packages/mcp-engine test

# --- 2. cli (pretest builds the bundle + engine) ---------------------------
run "cli: typecheck"               npm --prefix packages/cli run typecheck
run "cli: build + tests"           npm --prefix packages/cli test

# --- 3. server -------------------------------------------------------------
run "server: lint"                 npm run lint
if [ -f "$ENV_FILE" ]; then
  run "server: next build"         npx dotenv-cli -e "$ENV_FILE" -- npm run build
else
  printf '%s   (no %s — building with a placeholder DATABASE_URL)%s\n' "$DIM" "$ENV_FILE" "$RESET"
  run "server: next build"         env DATABASE_URL="postgres://placeholder/preflight" npm run build
fi
run "server: hosted integration"   npm run test:hosted

# --- summary ---------------------------------------------------------------
printf '\n%s━━ summary%s  %s(%ds total)%s\n' "$BOLD" "$RESET" "$DIM" "$((SECONDS - started))" "$RESET"
for s in "${PASSED[@]:-}"; do [ -n "$s" ] && printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$s"; done
for s in "${FAILED[@]:-}"; do [ -n "$s" ] && printf '  %s✗%s %s\n' "$RED" "$RESET" "$s"; done
printf '%s  (e2e not included — run it live: APP_BASE_URL=<url> npm run e2e)%s\n' "$DIM" "$RESET"

if [ "${#FAILED[@]}" -gt 0 ]; then
  printf '\n%s✗ %d/%d step(s) FAILED%s — not safe to push. Scroll up for details.\n' \
    "$RED$BOLD" "${#FAILED[@]}" "$STEP" "$RESET" >&2
  exit 1
fi
printf '\n%s✓ ALL CLEAR%s — %d steps. Safe to push.\n' "$GREEN$BOLD" "$RESET" "$STEP"
