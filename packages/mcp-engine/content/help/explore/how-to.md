---
description: Extended instructions working with this MCP server
---
# General Notes
Malloy is a combined semantic layer/query language. It describes data and analysis, and it can generate and execute SQL.

You answer questions from published Malloy semantic models. A model publishes sources and queries.

* Some tools return problems[] to indicate invalid Malloy.  problems may have a `help_topic` field — call `yo_help(help_topic)` for detailed guidance.
* `yo_help()` with no topic will show an index which include error explanations, examples of Malloy syntax for common patterns, and a language reference manual (Malloy syntax is still evolving).
* Tools that inspect Malloy code return objects with schemas, among other things.  An entry with a name which requires `back-tick-quoting` (reserved word, special characters), will have `must_quote: true`
* When limiting queries, do ranking, top-N, and member selection in Malloy, not in client code.  Results are byte-budgeted: oversized results are truncated (the response says so and may link the full result). Reading aggregated rows is better analysis and the only way to see everything.
* Compose your answer from what the model publishes. When composing a query, you can make new sources, extending existing sources with measures dimensions and joins. If the model's surface genuinely cannot answer a question, that is useful signal about the model.

# Answering A Question
To answer a question you need to see what sources are available which pertain to the question.

`list_sources` (when available) — see the sources you can query, grouped by model, with each model's named queries. If you already know the source, go straight to describe_source.

# Build the Query
* New to a pattern? `yo_help("explore/query-examples")` — the handful of Malloy query shapes (views, the workhorse group_by/aggregate, filtered aggregates, `all()`, `extend:`, `select:`, `nest:`) that cover almost every question, with the SQL habits that are wrong in Malloy.
* `describe_source(source, model_ref)` — always describe a source before querying it (`model_ref` optional when the name is unique). Returns:
  * `described_source` — the source's `dimensions` (columns), `measures`, and `views` (the author's saved queries). A dimension's `type` is a scalar or a nested record (`origin.city`); an array column has no `type` — it shows up as a `joins` entry at its `path`.
  * `joins` — keyed by path, the arrays and source-joins this source reaches. `fans_out` marks a path that fans out. Each entry is one of: `{ source }` (fields in `join_source_map`), `{ source_def }` (an anonymous source's fields, inline), or an array `{ is_array, source_def }` — a record array's fields are used directly (`parcels.sku`), a scalar array's element is `each` (`tags.each`). To write a reference, use the entry's `quoted_path` if it has one, else the key.
  * `join_source_map` — the named sources those `{ source }` joins resolve to, deduped.
  * In its own content block, the source's raw Malloy, for anything the structured output above doesn't cover.
* `query(source: "...", malloy: "run: source -> { ... }", execute: false)` — validate without running; it returns the SQL. Iterate until clean. (`model_ref` optional, needed only when the source name is ambiguous.)
* Some queries accept parameters (givens). More info if needed: yo_help("language/givens-model-level-parameters")

# Run the query
* Pass a plain-English question with EVERY query, describing what that specific query answers. Queries are recorded/shared independently. Don't try to group related queries.
* query(source: "...", malloy: "run: source -> { ... }", question: "...") — run it; get the rows.

# Displaying Results
* Lead with a natural-language restatement of the query — a short heading works well.
* A successful query comes back with an ltool_link — {text, url}, already assembled. It opens this exact query so the user can keep exploring, or share the insight. Follow the data with a markdown link, [↗ text](url).
* When it helps the reader add a short note on how you got the answer: the Malloy logic (filters, grouping, aggregation, ordering, pipeline stages), and any post-processing done outside Malloy.