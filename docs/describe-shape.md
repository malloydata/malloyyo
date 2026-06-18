# The canonical describe-shape

The **one** shape for "what's in a model," used by every surface — local fox MCP,
hosted explore endpoint `/mcp`, and any custom/per-customer server — projected per
surface. It's the **contract that makes surfaces congruent**, and it's the
library's deliverable #1 (the exported types). Decided by comparing malloy-cli's
`compile` output against today's malloyyo `describe_source`.

## Principles

- **Structured, never a raw `malloy_source` dump.** The agent reading it must never
  have to parse Malloy text — that's the whole point of compiling. (Today's
  `describe_source` ships the entire model source as a blob; drop it.)
- **Fields split into typed groups** (`dimensions` / `measures` / `views` /
  `joins`) — clearer for an AI than one flat `kind`-tagged list.
- **Keep what helps a query-writer:** each measure's `expression`, descriptions,
  and the full annotation set. (Today's `describe_source` drops these.)
- **Joins by reference**, with the response carrying the deduped closure of
  referenced sources, so refs resolve in-response and a shared source is described
  once. (Today's `describe_source` always inlines → duplication.)

## Shape

```jsonc
// result of describe / describe_source
{
  "requested": "orders",       // the source asked about
  "sources": {                 // requested source + transitive join targets, deduped, keyed by name
    "orders": {
      "name": "orders",
      "description": "…|null",                              // description annotation, promoted
      "primary_key": "id|null",
      "annotations": [{ "route": "...", "text": "..." }],   // full set (render tags, etc.)
      "dimensions": [ Field, … ],
      "measures":   [ Field, … ],
      "views":      [ View,  … ],
      "joins":      [ Join,  … ]
    },
    "customers": { … }         // referenced by orders.joins → described once here
  }
}

Field = {
  "name": "total_amount",
  "type": "number",            // string|number|date|timestamp|boolean|…
  "expression": "sum(amount)", // present when it differs from the name (esp. measures)
  "description": "…|null",
  "annotations": [ … ]         // optional
  // develop surface only: "location": [line, col]
}

View = {
  "name": "by_month",
  "description": "…|null"
  // develop surface only: "body": "<verbatim definition text>"
}

Join = {
  "name": "customer",
  "relationship": "one|many|cross",   // standardized vocab
  "source_ref": "customers",          // look up in sources{} above
  "description": "…|null"
  // develop surface only: "location": [line, col]
}
```

## Per-surface projection — same shape, different fields

- **explore:** omit `location`, omit view `body`, and **never** include raw
  `malloy_source`. Keep `expression`, descriptions, annotations.
- **develop:** add `location` everywhere + view `body` (verbatim) for
  jump-to-definition / editing. The structured shape replaces the raw-source dump.

This single definition supersedes both today's `describe_source` (thin + raw dump
+ always-inline joins) and malloy-cli's compile-only shape.

## Open

- **Split-into-typed-arrays** (current pick) vs **flat-`kind`** — going with split
  (an AI reading "here are the measures" is clearer), applied at every level.
- Relationship vocab standardized to `one|many|cross` (today malloyyo emits
  `one_to_many` etc.; malloy-cli emits `one|many|cross`).
