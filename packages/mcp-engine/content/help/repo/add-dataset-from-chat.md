---
description: Add a dataset to a model repo entirely from a chat — explore the database, write the model on a branch with GitHub's tools, check it here, merge, publish
---

# Adding a dataset from a chat

For someone who wants a new dataset without a terminal. You do the git work with
**GitHub's MCP tools**, as the person, in their repo. This instance answers what
only it can: what the repo's database connections can see, whether a branch
compiles here, and the publish after the merge.

These tools are for admins. If `list_repos` isn't in your tool list, the person
isn't an admin on this instance, and an admin has to add the dataset.

## Before you start

- **Check that you have GitHub's tools** (creating a branch, writing files,
  opening and merging a pull request). If you don't, tell the person they need
  the GitHub connector, and stop here.
- **`list_repos`.** Pick the repo with the person. Its `addingDatasets` line
  says whether this flow applies:
  - **multi-dataset repo** (`datasets/<name>/`): go ahead.
  - **single-dataset repo** (`index.malloy` at the root): a second dataset
    needs the repo restructured first. Say so; don't attempt it here.
  - **not on GitHub**: it was published with the CLI and can't be changed
    from here.

## 1. Look at the data

- `list_tables(repo, connection)`, with a `connection` from `list_repos`. Use
  `schema` or `like` to narrow it; BigQuery requires `schema` (the dataset).
- `describe_table(repo, connection, table)` for each table that matters:
  columns, row count, and five rows. On DuckDB the "table" can be a file path or
  URL (Parquet, CSV, JSON).

Then ask the person what they want to answer, before writing any Malloy: the
main entities, what one row of each table is, how the tables join, and the few
measures that matter (revenue, counts, rates). A model built from their
questions is much better than one transcribed from the schema.

## 2. Write it on a branch

With GitHub's tools:

1. Create a branch from the repo's published branch, e.g.
   `malloyyo/add-<name>`. **Never commit to the published branch directly.**
2. Add `datasets/<name>/index.malloy`. The directory name becomes the dataset's
   name, so make it a short lowercase slug. Use the connection names from
   `list_repos`: `source: orders is warehouse.table('sales.orders') extend { … }`.
   Give each source a `#"` description and its measures `#"` lines too; they're
   what people read in `describe_source`.
3. Commit with a message that says what the dataset is for.

Don't touch other datasets or `malloy-config.json` in the same change unless
the person asked for it. A connection or credential that doesn't exist yet is an
admin's job, outside this flow.

## 3. Check it here

`check_repo(repo, ref: "<commit SHA>")` compiles the repo at that commit exactly
as publishing would. Pass the SHA your last write returned, not the branch name:
GitHub can answer a branch name with the commit before yours for up to a minute
after a push, and you'd be shown errors you already fixed. Your dataset should
show `status: "new"` and `ok: true`, with its sources. Add a `test_query`
(`{dataset_dir: "datasets/<name>", malloy: "run: orders -> { aggregate: row_count is count() }"}`)
to see real numbers. Fix what it reports, commit again, and re-check.

### Try it like it's published: branch previews

To use the branch the way people will use the published dataset, with every
tool and its dashboards, run `fetch_branch(repo, branch)`. It takes a snapshot
of the branch and compiles it here. It answers with an address per dataset,
`<repo>@<branch>:<dataset>` (e.g. `shop@malloyyo/add-orders:orders`). Pass that
address as `model_ref` to `describe_source` and `query`, or send the person to
`/datasets/<address>` (URL-encoded) to see its dashboards.

- **A snapshot, not a live view.** Someone else may push to the branch, and the
  address keeps showing what you fetched until you fetch again. Fetch after each
  push you want to look at, and before you open the pull request.
- **Previews are for admins** and are never published. Queries against one
  don't make share links.
- Someone working locally can upload a working tree without pushing:
  `malloyyo publish --repo <owner/name> --branch`.

When it's clean, open a pull request with GitHub's tools. Say what the dataset
is, which tables it reads, and include a sample of the test query's result.

## 4. Check the pull request, then merge

`check_repo(repo, pull_request: <number>)` checks what merging would produce,
not just your branch. If someone changed the repo meanwhile, this is what
catches a merge that applies cleanly but breaks the model. Merge only on a clean
check. If GitHub says the pull request conflicts, redo the change on a fresh
branch from the published branch rather than splicing conflict markers.

Merging is the person's decision. Ask before you merge, even when you're able to.

## 5. Publish

`publish_repo(repo)`. It pulls the published branch and creates the new
dataset. Everything compiles or nothing changes. Then point the person at their
new dataset (`list_sources` shows it) and offer a first question or dashboard.
