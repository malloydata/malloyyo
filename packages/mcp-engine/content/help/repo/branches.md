---
description: Branch previews — a repo's unpublished changes, compiled and usable here as repo@label:dataset; the three ways to make one, and what they're good for
---

# Branch previews

A **preview** is a model repo with unpublished changes in it, compiled by this
instance with its own connections and usable as if it were published:
queries, `describe_source`, dashboards. Nothing about it is published. Only
admins can make or see one. The workflow for authoring with previews is in
`yo_help("authoring/start")`; this page covers previews themselves.

## The address

Each dataset in a preview gets an address:

    <repo>@<label>:<dataset>        e.g.  malloyyo_test@claude/returns:returns

The label is usually the branch name. Pass the address anywhere a dataset goes:

- as `model_ref` to `describe_source` and `query`
- as `dataset` to `show_dashboard`
- in a browser, as `/datasets/<address, URL-encoded>/dashboard/<name>`. Every
  tool that makes a preview returns these links, so give them to the person.

The page shows a banner naming the preview and its commit. Queries against a
preview make no share links.

## Making one

| From | Use | When |
| --- | --- | --- |
| Your clone (Claude Code on the web) | `preview_changes(repo, label, base, files, deleted)` | While authoring. Sends only your edits, committed or not; no push needed. |
| A branch on GitHub | `fetch_branch(repo, branch)`, or **Fetch from GitHub** on the repo's page | To look at a branch someone else pushed. |
| A local checkout with the CLI | `malloyyo publish --repo <owner/name> --branch` | Developing on your own machine. |

Each answers with every dataset's compile result, `ok` or the error, plus its
address and dashboard links. A dataset that doesn't exist on this instance yet
gets a preview like any other, which is how a new dataset is tried before it's
created.

## A snapshot, not a live view

A preview shows what was sent or fetched. Making another preview with the same
label replaces what that label's addresses show; older ones stay reachable by
commit SHA (`repo@<sha>:dataset`). So preview again after each round of edits,
or fetch again after each push you want to see. `list_repos` lists each repo's
latest previews.

## Then

A preview never becomes the published version. The published version always
comes from the repo's published branch. To ship:

1. Push the branch and open a pull request.
2. `check_repo(repo, pull_request: <n>)` checks what merging would produce.
3. The person merges.
4. `publish_repo(repo)`, or the repo's GitHub hook, publishes.
