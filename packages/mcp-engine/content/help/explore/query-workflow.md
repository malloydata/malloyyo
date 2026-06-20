---
description: Extended instructions for the query workflow
---

Build the Query
* `list_sources` — find the source you want
* `describe_source(source, model_ref)` — ALWAYS describe a source before querying it. It returns that source's dimensions, measures, views, and joins, plus the joined sources it reaches, and the source's Malloy. A source's `views` ARE its named queries — the author's curated analyses. (`model_ref` is optional when the source name is unique across the catalog.)
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