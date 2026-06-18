---
description: MALLOYYO-QUERY-WORKFLOW — querying a model step by step
---

1. `list_sources` — find the source you want (grouped by model, with each
   model's named queries).

2. `describe_source(source, model_ref)` — ALWAYS describe a source before
   querying it. It returns that source's dimensions, measures, views, and joins,
   plus the joined sources it reaches, and the source's Malloy. A source's
   `views` ARE its named queries — the author's curated analyses. (`model_ref`
   is optional when the source name is unique across the catalog.)

3. `query(source: "...", malloy: "run: source -> { ... }", execute: false)` —
   validate without running; it returns the SQL and which `$NAME` givens the
   query references. Iterate until clean.

4. `query(source: "...", malloy: "run: source -> { ... }")` — run it; get the rows.

Reuse what the model defines. The named queries are the author's curated
analyses — run by reference (`run: query_name`) or refine
(`run: query_name + { where: ... }`) before writing anything from scratch.
Prefer the model's existing measures, dimensions, and views over re-deriving
them. Supply `$NAME` givens via the `givens` map.

After every query — success or failure — show the user the Malloy that was
submitted. On a successful run, also show timing as "X ms total (Y ms compile)"
from `total_time_ms`/`compile_time_ms`.
