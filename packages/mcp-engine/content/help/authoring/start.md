---
description: Start here when authoring in a clone of a model repo (Claude Code on the web) — the setup checks, then the edit → preview_changes → propose loop
---

# Authoring a model repo from a clone

You're in a session with a clone of a model repo, such as Claude Code on the
web, and this instance's connector. Edit files in the clone. This instance
compiles your edits with its own warehouse connections and shows them, with
real data and dashboards, before anything is pushed. Git is only for proposing
the finished change.

## First: check the setup

Do these in order. If one fails, tell the person exactly what's wrong and stop.

1. **The tools.** You need `preview_changes`, `list_repos` and `check_repo`. If
   they're missing, either the person isn't an admin on this instance or the
   connector isn't turned on for this session. Say both possibilities.
2. **The repo.** Run `git remote get-url origin`. `list_repos` must list a repo
   whose `github` is that `owner/name`. If none does, the instance doesn't
   publish this repo, and an admin has to add it.
3. **The round trip.** Call `preview_changes` with no files:
   - `repo`: the remote, as printed
   - `label`: `git branch --show-current`
   - `base`: `git merge-base HEAD origin/<published branch>`. `list_repos` names
     the published branch, usually `main`.

   Every dataset should come back `ok`. If one doesn't, it's broken on the
   published branch too. Say so before you change anything.

Then tell the person it works and ask what they want, unless they already said.

## The loop

1. **Branch.** Work on a branch named for the task, e.g. `claude/returns`.
   Never commit to the published branch.
2. **Look before writing.**
   - For a new dataset, read the data first with `list_tables` and
     `describe_table`, and ask the person what it should answer.
   - For a change, read the model and the dashboards in the clone.
     `dashboards/*.malloy` and their components exist only here, not in this
     instance's tools.
3. **Edit, then `preview_changes`.** Send only what differs from `base`:
   - `files`: the full text of each file in `git diff --name-only --diff-filter=d <base>`
     (changed or added; `d` leaves out deletions), plus
     untracked files (`git ls-files --others --exclude-standard`).
   - `deleted`: files removed since `base` (`git diff --name-only --diff-filter=D <base>`).
   - Committed or not doesn't matter. The preview is your working copy.
4. **Read the answer.** Each dataset is either `ok`, with sources and
   dashboards, or `FAILED` with the compile error. Fix it and preview again.
5. **Check the numbers.** Use `query` and `describe_source` with the preview
   address as `model_ref`, e.g. `malloyyo_test@claude/returns:returns`. Do the
   work in Malloy, not by post-processing rows.
6. **Show the person.** Give them the dashboard links from the answer. The pages
   are previews: only admins see them, and nothing is published.
7. Repeat. Each `preview_changes` replaces what that label's addresses show.

## Adding a dataset

- **Check the repo's layout first.** `list_repos` says it in `addingDatasets`.
  A repo with `datasets/<name>/` directories takes a new one directly. A
  single-dataset repo (`index.malloy` at its root) needs restructuring first;
  `yo_help("repo/datasets")` covers that, and it's a separate change to agree
  with the person.
- **Look at the data.** Use `list_tables(repo, connection)` with a connection
  from `list_repos`; narrow it with `schema` or `like`, and on BigQuery
  `schema` (the dataset) is required. Then `describe_table` for each table
  that matters: columns, row count and five rows. On DuckDB, a "table" can be
  a file path or URL (Parquet, CSV, JSON).
- **Ask before modeling.** Find out what the person wants to answer: the main
  entities, what one row of each table is, how the tables join, and the few
  measures that matter. A model built from their questions beats one copied
  from the schema.
- **Write `datasets/<name>/index.malloy`.** The directory names the dataset,
  so make it a short lowercase slug. Use the connection names from
  `list_repos`, e.g. `source: orders is warehouse.table('sales.orders') extend { … }`.
  Give each source a `#"` description, and each measure one too; they're what
  people read in `describe_source`.
- **Stay in your lane.** Don't touch other datasets or `malloy-config.json`
  unless the person asked. A connection or credential that doesn't exist yet is
  an admin's job, outside this change.
- **It's created at publish.** Until then, the new dataset exists only in
  previews (`status: "new"`).

## Proposing it

When the person is happy with it:

1. Commit with messages that say why, then push the branch.
2. Open a pull request, saying what changed and including a sample result.
3. `check_repo(repo, pull_request: <number>)`. This checks what merging would
   produce. A green preview doesn't cover changes others made to the published
   branch since you started.
4. **Merging is the person's decision.** Ask first, even if you can merge.
5. After the merge, `publish_repo(repo)`, unless the repo publishes on push. New
   datasets are created then.

## Good to know

- **Limits.** One preview carries up to 200 changed files and 512KB. Beyond
  that, push the branch and use `fetch_branch(repo, branch)`, which reads it
  from GitHub.
- **`base` must be on GitHub.** The merge-base with the published branch always
  is. If you rebased onto newer work, recompute it.
- **Malloy syntax.** `#"` is a description, a line starting with `#` is an
  annotation (not a comment), and `//` is a comment.
- **Drafts.** Dashboards someone made in chat are drafts. Promoting one into
  the repo is in `yo_help("dashboards/drafts")`.
- **Branch previews** in more depth are in `yo_help("repo/branches")`.
- **A repo that isn't on GitHub** was published with the CLI. There's no clone
  to author in, so it can't be changed this way.
