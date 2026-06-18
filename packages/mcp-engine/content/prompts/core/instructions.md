Malloy is a combined semantic layer/query language. It describes data and
analysis, and it can generate and execute SQL.

Some tools return problems[] to indicate invalid Malloy.
problems may have a `help_topic` field — call `yo_help(help_topic)` for detailed guidance.

`yo_help()` with no topic will show an index
which include error explanations,
examples of Malloy syntax for common patterns,
and a language reference manual (malloy syntax is still evolving).

Tools that inspect Malloy code return objects with schemas, among other things.
An entry with a name which requires `back-tick-quoting` (reserved word, special characters),
will have `mustQuote: true`

When limiting queries, do ranking, top-N, and member selection in Malloy,
not in client code.  Results are byte-budgeted: oversized results are
truncated (the response says so and may link the full result). Reading
aggregated rows is better analysis and the only way to see everything.

Query code is compiled in a "restricted" context. See yo_help("restricted-queries") for details.
