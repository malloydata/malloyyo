---
name: malloy-update
description: Bump @malloydata/* to the latest published version and ship it end to end — fresh main → worktree → npm run malloy-update → preflight → PR → wait green → merge → wait for the release action → report the new @malloydata/malloyyo version → clean up. Use when the user wants to pull a new Malloy npm release into this repo (e.g. "/malloy-update", "update malloy", "pull the new malloy").
---

# malloy-update

Drive a Malloy npm bump from a clean main all the way to a published release of
this repo's CLI (`@malloydata/malloyyo`). Run from the primary `~/yo` checkout.

This is a long, mostly-unattended pipeline with real stop conditions. Work the
steps in order, **stop the moment a stop condition fires**, and report what
happened. Don't invent fallbacks — if something is red, surface it and halt.

## Tools you'll lean on

- `npm run --silent malloy-update -- --json` — machine-readable bump result on
  stdout: `{ "primary": "<@malloydata/malloy version>", "changed": bool,
  "packages": [{name, from, to}] }`. Human chatter and pnpm output go to stderr.
  Add `--dry-run` to peek without writing anything.
- `npm run preflight` → `bash scripts/preflight.sh` — the offline gate
  (typecheck + unit + cli build + server lint + `next build` + hosted-explore
  integration test). **Needs a running Docker daemon**; if Docker is down the
  hosted test fails — tell the user rather than papering over it.
- `gh` for the PR (`gh pr create`, `gh pr checks --watch`, `gh pr merge`) and the
  release run (`gh run list/watch --workflow=cli-publish.yml`). Assume it's authed.

## Steps

### 1. Preconditions on main — STOP if violated

```bash
git -C ~/yo rev-parse --abbrev-ref HEAD     # must be: main
git -C ~/yo status --porcelain              # must be empty (clean tree)
git -C ~/yo fetch origin
git -C ~/yo pull --ff-only origin main
```

STOP and report if: not on `main`, the tree is dirty, or the pull isn't a clean
fast-forward. Don't stash or force anything.

### 2. Peek the target version — STOP if not new

```bash
npm run --silent malloy-update -- --dry-run --json > /tmp/malloy-update.json
cat /tmp/malloy-update.json
```

(stdout → file is the clean JSON; stderr stays on screen so you still see the
per-package report and any error.) Parse `changed` and `primary`. **If `changed` is false, STOP**: report
"`@malloydata/*` already at the latest (`<primary>`) — nothing to do." No
worktree, no PR. Otherwise capture `V=<primary>` (e.g. `0.0.417`) — that's the
version that names the branch, the PR, and the report.

### 3. Worktree off fresh main

```bash
git -C ~/yo worktree add -b malloy-update-$V ~/yo-malloy-update-$V main
```

(The existing convention is a `malloy-update-<version>` branch — see the merged
`#40 malloy-update-0.0.416`.) Do all remaining work in `~/yo-malloy-update-$V`.

### 4. Run the real update

```bash
cd ~/yo-malloy-update-$V
npm run --silent malloy-update -- --json > /tmp/malloy-update.json
cat /tmp/malloy-update.json
```

`pnpm update` here also populates this worktree's `node_modules`. Confirm
`changed` is true and `primary` matches `$V`; **report the bump** (`from -> to`
per package, lead with `@malloydata/malloy`). If preflight later complains about
missing deps, run `pnpm install` in the worktree and retry.

### 5. Preflight — STOP if red

```bash
npm run preflight        # i.e. bash scripts/preflight.sh, in the worktree
```

Green → continue. Red → STOP, show the failing step's output, leave the worktree
in place so the user can inspect. Do not open a PR on a red preflight.

### 6. Commit + PR

```bash
git -C ~/yo-malloy-update-$V add -A
git -C ~/yo-malloy-update-$V commit -m "Update to Malloy npm package $V"
git -C ~/yo-malloy-update-$V push -u origin malloy-update-$V
gh pr create --repo malloydata/malloyyo --base main --head malloy-update-$V \
  --title "Update to Malloy npm package $V" \
  --body "Update to Malloy npm package $V"
```

Title and body are exactly `Update to Malloy npm package $V` — no changelog, the
diff speaks for itself.

### 7. Wait for PR CI green — STOP if red

```bash
gh pr checks malloy-update-$V --watch
```

This blocks until the `preflight` workflow finishes. Green → continue. Failed →
STOP and report which check failed (don't merge a red PR).

### 8. Merge + wait for the release action

The repo merges with a merge commit (see `#40`), and touching
`packages/cli/**` / `packages/mcp-engine/**` on `main` triggers `cli-publish.yml`,
which patch-bumps and publishes `@malloydata/malloyyo` (committing a `[skip ci]`
bump back).

```bash
gh pr merge malloy-update-$V --merge --delete-branch
gh run list --repo malloydata/malloyyo --workflow=cli-publish.yml --limit 1   # find the run
gh run watch <run-id> --repo malloydata/malloyyo --exit-status                # block until done
```

STOP and report if the release run fails.

### 9. Report the new published version

```bash
npm view @malloydata/malloyyo version
```

Report: the Malloy package the PR pulled in (`$V`) **and** the new published
`@malloydata/malloyyo` version produced by the release.

### 10. Clean up

```bash
git -C ~/yo worktree remove ~/yo-malloy-update-$V        # add --force only if it refuses on untracked build output
git -C ~/yo branch -D malloy-update-$V 2>/dev/null || true   # local branch (remote already deleted on merge)
git -C ~/yo pull --ff-only origin main                   # pick up the release's [skip ci] bump
```

Then a short final summary: Malloy `$V` in, `@malloydata/malloyyo <new>` out,
worktree gone, `main` up to date.
