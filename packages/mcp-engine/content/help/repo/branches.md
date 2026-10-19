---
description: Change a repo's models or dashboards on a branch and see them here before they're published — where the files are, check_repo, fetch_branch previews and their links
---

# Working on a branch

To change a published model or its dashboards without changing what people see,
work on a branch of the model repo and look at it here as a **preview**. Branch
previews are for admins. If `fetch_branch` isn't in your tool list, either the
person isn't an admin here or your client loaded its tools before this one
existed (reconnecting fixes that).

## 1. Get the files

This instance serves compiled models, not repo files. `describe_source` shows
sources, dimensions and measures, but not the Malloy text behind a dashboard
(`dashboards/*.malloy`) or its components (`*.jsx`). Those are in the repo.

- `list_repos` names each repo's GitHub repo (`owner/name`) and published branch.
- Read and write the files with **GitHub's tools**, or in a clone if you have
  one. Make a branch off the published branch; never commit to the published
  branch.

## 2. Check that it compiles

`check_repo(repo, ref)` reads the repo **from GitHub**, so push first. Pass
the commit SHA you just pushed, not the branch name: right after a push, GitHub
can answer a branch name with the previous commit for up to a minute. It
compiles every dataset and dashboard the way publishing would. Add a
`test_query` to see numbers at that commit.

## 3. Look at it: `fetch_branch`

`fetch_branch(repo, branch)` takes a snapshot of the pushed branch, compiles it,
and gives each dataset a preview address:

    <repo>@<branch>:<dataset>        e.g.  malloyyo_test@imdb-calcs:imdb

Pass that address anywhere a dataset goes:

- `describe_source` and `query`, as `model_ref`
- `show_dashboard`, as `dataset`
- in a browser, `/datasets/<address, URL-encoded>/dashboard/<name>`.
  `fetch_branch` returns these links for every dashboard, so give them to the
  person.

The page shows a banner naming the branch and commit. Nothing is published:
queries make no share links, and only admins can open the pages.

**A snapshot, not a live view.** The address keeps showing what was fetched
until someone fetches again, so `fetch_branch` again after every push you want
to look at. `list_repos` lists the branches already fetched and when.

## 4. From a clone, without pushing

In a session with a clone of the repo (Claude Code on the web),
`preview_changes` sends your working copy's edits and previews them in one
step, with no push. It's the loop to use there; `yo_help("authoring/start")`
has it.

## 5. From a local working tree

Someone with a clone and the CLI can skip the push:

    malloyyo publish --repo <owner/name> --branch

This uploads the working tree, including uncommitted changes, as a preview of the
current git branch (`--branch <name>` picks another). It prints the addresses the
same way.

## 6. Ship it

Open a pull request, run `check_repo(repo, pull_request: <n>)` on it, and let the
person decide to merge. Then `publish_repo(repo)`, or the repo's GitHub hook,
publishes the merged result. A preview never becomes the published version; the
published version always comes from the published branch.
