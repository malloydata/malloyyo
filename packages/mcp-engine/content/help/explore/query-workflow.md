---
description: Extended instructions for the query workflow
---

Build the Query
* `list_sources` — find the source you want
* `describe_source(source, model_ref)` — always describe a source before querying it (`model_ref` optional when the name is unique). Returns:
  * `described_source` — the source's `dimensions` (columns), `measures`, and `views` (the author's saved queries). A dimension's `type` is a scalar or a nested record (`origin.city`); an array column has no `type` — it shows up as a `joins` entry at its `path`.
  * `joins` — keyed by path, the arrays and source-joins this source reaches. `fans_out` marks a path that fans out. Each entry is one of: `{ source }` (fields in `join_source_map`), `{ source_def }` (an anonymous source's fields, inline), or an array `{ is_array, source_def }` — a record array's fields are used directly (`parcels.sku`), a scalar array's element is `each` (`tags.each`). To write a reference, use the entry's `quoted_path` if it has one, else the key.
  * `join_source_map` — the named sources those `{ source }` joins resolve to, deduped.
  * In its own content block, the source's raw Malloy, for anything the structured output above doesn't cover.
* `query(source: "...", malloy: "run: source -> { ... }", execute: false)` — validate without running; it returns the SQL. Iterate until clean. (`model_ref` optional, needed only when the source name is ambiguous.)
* Some queries accept parameters (givens). More info if needed: yo_help("language/givens-model-level-parameters")

Run the query
* Pass a plain-English `question` with EVERY query, describing what that specific query answers. Queries are recorded/shared independently. Don't try to group related queries.
* `query(source: "...", malloy: "run: source -> { ... }", question: "...")` — run it; get the rows.
* After EVERY query you MUST output a "Query summary":
  (1) the question in plain English,
  (2) the Malloy logic (filters, grouping, aggregation, ordering),
  (3) any post-processing done outside Malloy, or "none". Omitting it is an error.
  (4) When a query response contains `ltool_link`, use the fields inside to create link `[↗ text](url)]`