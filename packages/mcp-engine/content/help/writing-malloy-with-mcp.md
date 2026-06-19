---
description: How to write Malloy over an MCP surface — the compiler-in-the-loop discipline, common errors, and givens. Tool-agnostic; read once.
---
# Writing Malloy over MCP

Malloy is a semantic language: a source already carries measures, dimensions,
views, and joins, and the compiler typechecks every query against them. The
single most useful habit is **let the compiler be ground truth** — don't guess
syntax or field names. Read the source's shape first, validate before you run,
and read the `problems[]` the surface returns.

The exact tools differ by surface (an explore surface exposes describe + query;
an authoring surface adds compile/prettify), but the loop is the same:

1. **Read the shape.** Describe the source you're querying — its measures,
   dimensions, views, and joins. The model usually already defines the
   aggregation you want; reuse it instead of re-deriving it.
2. **Validate, then run.** Compile/validate the query first (no execution) to
   confirm it typechecks and to see the generated SQL or the givens it needs;
   fix any `problems[]`, then execute to get rows.
3. **Recover from problems[].** Every failure — parse, field-not-found,
   aggregate-locality, runtime — comes back as a uniform `problems[]` with a
   `code` and (when known) a `help_topic`. Pull that topic with `yo_help`.

## Common errors and how to read them

- **Unknown field** — describe the source and check its dimensions / measures /
  views / joins for what actually exists. A join rendered by `source_ref` is
  described under that name in the same response.
- **Aggregate locality** — `sum(joined.x)` across a join needs explicit
  locality: `source.sum(joined.x)` or `joined.x.sum()`.
- **Mixed reduction / projection** — one query stage is either
  `group_by:`/`aggregate:` OR `select:`, never both.
- **Calculation in a source** — `calculate:` (window functions) lives in
  queries, not in source definitions.

## Givens (`$NAME` parameters)

Some models declare given parameters (`$TENANT`, `$MAX_ROWS`, …). Validate a
query with execution off to learn which givens it references (with their types
and whether a default exists), then supply values keyed by surface name (no
`$`). A given with a default is optional; one without must be supplied. For the
per-type value shapes (dates as ISO strings, records as objects, `filter<T>` as
a Malloy filter string, …) pull `yo_help("givens")` — don't guess; the compiler
validates and points at the offending field.

## Before writing non-trivial Malloy

Browse the `language/*` topics first (start with `yo_help("language/overview")`).
The language has real scoping and typing rules the compiler enforces — reading
the reference beats guessing.
