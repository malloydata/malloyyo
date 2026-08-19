# GitHub history → parquet → semantic model

Everything GitHub knows about `malloydata/malloy` and `malloydata/malloyyo`,
flattened into parquet and modelled in Malloy.

```
extract/git_history.py    local clones ──▶ commits, commit_files, tags
extract/github_api.py     GitHub REST ──▶ raw/*.json
extract/build_parquet.py  raw/*.json  ──▶ issues, pull_requests, releases,
                                          comments, review_comments, reviews
extract/link.py           the above   ──▶ identities   (email ⇄ login)
index.malloy              data/*.parquet ──▶ the semantic model
```

## The tables

`data/` holds one file per entity; every table has a `repo` column, so both
repos live in the same file and any query can group by, or filter to, one.

| table | rows | cols | key columns |
| --- | ---: | ---: | --- |
| `commits.parquet` | 6,583 | 32 | `repo`, `sha`, `author_email`, `authored_at`, `subject`, `pr_number`, `insertions`, `deletions`, `commit_type` |
| `commit_files.parquet` | 36,084 | 16 | `repo`, `sha`, `path`, `top_dir`, `extension`, `is_test`, `is_docs`, `insertions`, `deletions` |
| `tags.parquet` | 440 | 9 | `repo`, `tag`, `sha`, `tagged_at`, `version` |
| `issues.parquet` | 735 | 21 | `repo`, `issue_number`, `title`, `body`, `state`, `author_login`, `labels`, `comment_count` |
| `pull_requests.parquet` | 2,382 | 27 | `repo`, `pr_number`, `title`, `body`, `state`, `is_merged`, `merged_at`, `head_repo`, `from_fork` |
| `releases.parquet` | 100 | 16 | `repo`, `tag_name`, `published_at`, `body`, `pr_numbers` |
| `identities.parquet` | 100 | 11 | `email`, `login`, `match_source`, `confidence` |

2.8 MB in total. Every `*_at` column is a real UTC timestamp, so the model can
do `.month` / `.year` and time arithmetic directly.

## The two joins that make it a model rather than seven tables

**Commit → pull request.** A squash-merge subject ends in `(#123)`, and a merge
commit starts with `Merge pull request #123`; `git_history.py` parses both into
`commits.pr_number`. That covers 1,871 of 1,883 merged malloy PRs (99.4%) and
123 of 125 for malloyyo — and it is what puts a real diff size behind pull
request metadata, because GitHub's list-pull-requests API does not return
`additions`/`deletions` at all.

**Commit → person.** Commits carry an email, the API carries a login, and
nothing joins them. `link.py` derives the mapping from three signals:

| signal | how | share of commits |
| --- | --- | ---: |
| `squash-merge` | the merged PR's author *is* the author of the commit that landed it | 48% |
| `name-match` | a display name that resolves to exactly one login carries over to that person's other addresses | 20% |
| `noreply-address` | `1234567+octocat@users.noreply.github.com` states the login outright | 15% |

83% of commits resolve to a login; the rest are mostly CI bots and one-off
addresses. `match_source` and `confidence` travel with every row, so a query
can insist on a stronger reading.

## Rebuilding

```bash
pip install duckdb pyarrow

# the git side -- needs FULL clones (git fetch --unshallow)
python3 extract/git_history.py --out data \
  --repo ~/dev/malloy=malloydata/malloy \
  --repo ~/dev/malloyyo=malloydata/malloyyo

# the API side
GITHUB_TOKEN=ghp_... python3 extract/github_api.py \
  --repo malloydata/malloy --repo malloydata/malloyyo --out raw
python3 extract/build_parquet.py --raw raw --out data

# the crosswalk, last -- it reads the two tables above
python3 extract/link.py --parquet data
```

`build_parquet.py` classifies records by shape rather than by filename and
de-duplicates on `(repo, number)`, so re-running it over a `raw/` that has
grown new pages is safe and idempotent.

## What is not in here yet

**Comments, reviews, and inline review comments.** `github_api.py` collects
them — `/issues/comments` and `/pulls/comments` are repo-wide streams, so the
whole conversation history is a few hundred requests, not one per issue — and
`build_parquet.py` already normalises them into `comments.parquet`,
`review_comments.parquet` and `reviews.parquet`. They are absent from `data/`
only because the session that built this snapshot reached GitHub through a
proxy that serves the list endpoints but not those streams. Run the collector
with a normal token and they fill in; the model gains three sources with no
change to the six that are already here.

Also worth knowing: `releases.parquet` holds the most recent 100 releases —
`/releases` stopped paginating past the first page for `malloydata/malloy`.
`tags.parquet` has all 440 tags from git, so release *cadence* is complete even
though the older release *notes* are not.

## The model

`index.malloy` defines seven sources. `commits` is the one to start from — it
joins to `identities`, to `pull_requests`, and to `commit_files`:

```malloy
run: commits -> top_contributors       // people, addresses folded together
run: commits -> by_month               // commit and line volume over time
run: commits -> hot_areas              // where the churn lands
run: commits -> merged_pr_sizes        // PR metadata + the diff that landed
run: pull_requests -> by_author        // volume, merge rate, turnaround
run: pull_requests -> outside_contributions
run: issues -> by_label
run: releases -> cadence
run: commit_files -> hottest_files
```

Ad-hoc queries compose the same way:

```malloy
run: commits -> {
  where: pr.is_merged and repo = 'malloydata/malloy'
  group_by: by_quarter is authored_at.quarter
  aggregate:
    commit_count
    lines_added
    avg_hours_to_merge is pr.hours_to_merge.avg()
    from_forks is count(pr_number) { where: pr.from_fork }
  order_by: by_quarter asc
}
```
