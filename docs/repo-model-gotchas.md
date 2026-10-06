# Gotchas: what the first multi-dataset-repo implementation taught us

Written after `multi-dataset-repos` (PR #188) went through three independent
reviews. That branch works and is well tested. It is being rewritten anyway,
because every serious finding traced back to one decision, and the cheapest
moment to change a data model is before more rows exist in it.

This file is the carried-forward knowledge. Each item cost real time to find, and
each names what it cost, because a rule without its failure attached gets
rationalised away by the next person in a hurry.

## The root cause

**The repo was not an entity.** It was a query predicate: `datasets` rows that
happened to share `(github_repo, github_branch)` — two nullable text columns that
any admin could edit independently. The PR's organising principle was "the repo
is the atomic unit of publish," and the unit of publish did not exist as a thing.

Everything below is either a direct consequence of that or a lesson learned
alongside it.

## 1. One definition of "what is in the repo"

Git decides. Never a hand-maintained skip list.

The first implementation walked the filesystem and filtered by a list of
directory names. It cost, in one commit:

- a dataset legitimately named `datasets/docs/` counted in the CLI's own output
  ("2 dataset(s): docs, sales") and packed into the archive with **none of its
  files** — a half-publish reporting success;
- `docs/shared.malloy` dropped from a single-dataset repo that imported it, so
  the model compiled locally and arrived broken;
- `malloy-config-local.json` — Malloy's local override, the file that by design
  holds real credentials while the shared one holds `{"env": …}` refs, and which
  is usually gitignored — read off disk and uploaded. The walker read the
  filesystem, not git, so gitignore did not save it.

And before that list existed, the same walker packed 7.15 MB of emitted bundle
JavaScript out of a committed `docs/` directory.

The skip list was reaching for "the static site we emitted." Judge a directory by
what it **contains**, not by what it is called — or better, let `git archive` /
the GitHub tarball answer the question and have no list at all.

## 2. The server must compile the way the CLI compiles

Most findings across three reviews were divergence between an in-memory file map
on the server and a real filesystem on the author's machine:

- **symlinks**: `fsLister` used `Dirent.isDirectory()/isFile()`, which does not
  follow them, while the archive walker used `statSync`, which does. A repo that
  symlinked a dataset directory linted as empty and published two datasets.
- **empty files**: the extractor dropped zero-length members before recording
  them as skipped, so `touch datasets/finance/index.malloy` made that dataset
  stop existing as far as the server was concerned. The layout rules key on a
  file EXISTING, not on its contents.
- **invisible directories**: the archive lister inferred directories only from
  files it kept, so a dataset directory holding only non-kept files did not exist
  server-side while `lint` saw it fine.
- **config discovery**: the server checked two locations for
  `malloy-config.json`; Malloy's own `discoverConfig` walks **every** intermediate
  directory. `datasets/malloy-config.json` therefore linted clean and failed on
  the server — with a comment above the server code asserting the two could not
  disagree.

"Lint blesses a repo the server then refuses" is the defining bug of this
feature. The fix is not more care at each site; it is to make both sides compile
against the same thing.

## 3. No compensating actions

If a path needs cleanup-on-failure, the design is inverted.

`POST /api/repos/push` inserted dataset rows, compiled, and deleted them again if
the compile failed. That passes every test you can write against a process that
stays alive. The compile does network I/O and resolves schemas by running SQL, so
a function timeout or a redeploy in the middle left `ready` rows with no model
behind them — holding their names under a partial unique index, with nothing on
the instance able to release them. The rightful publish afterwards got a 409,
permanently, fixable only by hand in the database.

Make the unit of work a single commit, or a pointer flip. Then there is nothing
to compensate for.

## 4. Repo-level facts live on the repo

`github_use_token` is a property of a repo — can we read it? — and was stored
once per dataset. In the production fork, one repo had three rows with two
different values, and the refresh picked a winner with `rows[0]` on a query with
no `ORDER BY`. For a private repo that is an intermittent, unexplainable failure
that flips with row order.

The UI made it worse: the config form hardcoded `githubUseToken: true` on every
save while the CLI publish path wrote `false`, so any repo touched by both had
mixed values by construction.

## 5. Never infer membership from denormalized columns

`refreshRepo` recomputed "which datasets are this repo?" on every call by
matching those two text columns, with no status filter. Measured against the
production fork: one repo had **seven** matching rows, none of them `ready`. A
single webhook push would compile the same model seven times and write seven
model versions for datasets nobody can see. Another had one live dataset and two
dead ones — and because the refresh is all-or-nothing, a compile failure in
either zombie meant nothing was written for the healthy one.

## 6. "These belong together" is not "GitHub backs this"

One pair of columns meant both. So the CLI publish path, needing to express the
first, had no way to avoid asserting the second: it stamped `github_repo` and the
author's **local** branch name onto every dataset it created. The refresh button
would then try to pull `github.com/<slug>@wip`, and if that branch happened to
exist, GitHub's content silently replaced what was just pushed.

Separate the two facts. A repo that arrived by CLI should say so, and be
attachable to GitHub later as a deliberate act.

## 7. A comment asserting an invariant needs a test enforcing it

Three comments in that branch claimed a single source of truth and were false:

- `dashboard-tree.ts` said the filter lives in the engine so that "what does this
  search match" has one answer "wherever you are looking at it", and named the
  CLI switcher as the second consumer. The CLI switcher reimplements the matching
  in a hand-written JavaScript string.
- `github-refresh.ts` said its config resolution "is the same answer
  `discoverConfig` gives the CLI". It is not (see §2).
- `repos/push` said "nothing here pulls from GitHub, so a token would never be
  used", on the lines that make the row GitHub-refreshable forever.

A false invariant comment is worse than no comment: it tells the next reader to
stop checking. Either enforce it with a test or do not write it.

## 8. A test that passes against the broken code is not a regression test

Prove both directions, every time: revert the fix, watch the test fail, restore
it, watch it pass.

Two tests written during this work did not do what their names claimed. One
asserted landing-page behaviour using fixtures that were filtered out before the
assertion ran, so it passed against an empty page. Another pinned an all-or-
nothing contract that the broken implementation also satisfied, because the test
process lived long enough to run the old cleanup — the window it was supposedly
covering needs a dying process and is not reachable from a test at all.

When a property genuinely cannot be tested, say so in the test, and pin the
mechanism separately.

## 9. Do not hand-roll archive parsing

A tar reader and writer were written by hand to avoid a dependency. Five bugs
were found in them across the reviews — a bomb-able unbounded gunzip, silent
truncation, a dropped ustar prefix, missing path sanitisation, and the dropped
empty files in §2 — and **all five were in the reader**, which has to exist
regardless because the server extracts GitHub's tarball.

Take a dependency. Keep archive handling host-side, where the engine's
no-runtime-dependency rule does not apply.

Related: `.tar.gz` cannot be read partially — gzip is one stream. A zip has a
central directory with per-member offsets and independent deflate, so one file
can be read without inflating the rest. If partial reads might ever matter, that
is the format choice that preserves the option.

## 10. Names are load-bearing

Dataset names *were* globally unique per instance, and more things depended on
that than it looked: `resolveDatasetByRef` (used by both the publish API and MCP)
fell back to name lookup, `--dataset <name>` targeted by name, and shareable
query slugs and saved MCP client configs are out there in the world. (Role grants
are not in that list: they are role names on the dataset row, set by uuid.)

Names are now scoped to a repo and the address is the qualified `repo:dataset`,
with `dataset_aliases` carrying the old bare names forward — the migration this
gotcha asked for, shipped in #189.

The lesson that outlived the fix is the one worth keeping: **a value that is both
a label and an address will be used as the wrong one.** Scoping the names did not
end it, it moved it. Afterwards, six places still used the bare name as an
address — including `/api/history`, which answered "no questions yet" for every
repo-backed dataset — and one UI heading started reading
`malloyyo_babynames:babynames` because the field that fixed the address was also
the field that was displayed. When you touch one of these, check which job each
value is doing, and split them when it is both. `/api/favorited-queries` still
keys by bare name, and says so.

## 11. Two smaller ones, for completeness

**Piping masks exit codes.** `npm run test:migrate | tail -6` reported success on
a failing run. Capture full output; check the status separately.

**Stale builds lie.** `test:migrate` runs against a built standalone server, and
a stale `npm run build` fails phase 5 with an error that looks like a migration
bug. The same class bit a dev server twice, serving old code after an edit. When
a result is confusing, confirm what is actually running before debugging what it
did.
