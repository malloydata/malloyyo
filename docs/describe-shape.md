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

Two layers carry this shape. The pure selection helper returns
`SourceDescription { requested, sources }`; the `describe_source` TOOL wraps it
as `SourceDescribeResult { ok, model_ref, source, sources, malloy_text?, problems }`
— `source` is the wire key for the requested name, and the requested source +
its join closure ride out verbatim as a separate `malloy_text` block (so Malloy
is never escaped inside JSON). The `sources` map shape:

```jsonc
"sources": {                 // requested source + transitive join targets, deduped, keyed by name
  "orders": {
    "name": "orders",
    "description": "…",       // #" doc route, promoted; OMITTED when absent
    "instructions": "…",      // #(agent) route, promoted; OMITTED when absent
    "must_quote": true,       // only when the name needs backtick-quoting in Malloy
    "primary_key": "id|null", // the one field that is null (not omitted) when there is none
    "annotations": [{ "route": "...", "text": "..." }],  // leftover routes (render tags, …)
    "dimensions": [ Field, … ],
    "measures":   [ Field, … ],
    "views":      [ View,  … ],
    "joins":      [ Join,  … ],
    "anon_srcs":  [ Source, … ]  // un-nameable join targets (see Join.anon_src_index); omitted when none
  },
  "customers": { … }          // referenced by orders.joins → described once here
}

Field = {
  "name": "total_amount",
  "type": "number",            // string|number|date|timestamp|boolean|…
  "expression": "sum(amount)", // present only when it differs from the name (esp. measures)
  "description": "…",          // #" route; omitted when absent
  "instructions": "…",         // #(agent) route; omitted when absent
  "must_quote": true,          // only when the name needs backtick-quoting
  "annotations": [ … ]         // leftover routes; omitted when empty
  // develop surface only: "location": [line, col]
}

View = {
  "name": "by_month",
  "description": "…", "instructions": "…", "must_quote": true,  // each omitted when absent
  "body": "<verbatim definition text>"   // sliced from its location, when readSource was available
  // develop surface only: "location": [line, col]
}

Join = {
  "name": "customer",
  "relationship": "one_to_many | many_to_one | cross",  // descriptive vocab
  "source_ref": "customers",      // nameable target → look up in sources{} above
  "anon_src_index": 0,            // OR: un-nameable target → index into the owning source's anon_srcs
  "description": "…", "instructions": "…", "must_quote": true,  // each omitted when absent
  "body": "<verbatim `name is target on …` text>"   // when readSource was available
  // develop surface only: "location": [line, col]
  // invariant: a join has source_ref, anon_src_index, and/or inline fields
}
```

## Per-surface projection — same shape, different fields

- **explore:** omit `location`, omit view `body`, and **never** include raw
  `malloy_source`. Keep `expression`, descriptions, annotations.
- **develop:** add `location` everywhere + view `body` (verbatim) for
  jump-to-definition / editing. The structured shape replaces the raw-source dump.

This single definition supersedes both today's `describe_source` (thin + raw dump
+ always-inline joins) and malloy-cli's compile-only shape.

## Settled

- **Split-into-typed-arrays** (not flat-`kind`) — an AI reading "here are the
  measures" is clearer; applied at every level.
- **Relationship vocab is descriptive** — `one_to_many | many_to_one | cross`
  (the join's fan-out direction), not the terser `one|many|cross`.
- **Two annotation channels** — `#"` → `description` (for humans), `#(agent)` →
  `instructions` (for the agent using the object). Both promoted out of
  `annotations[]` and omitted when absent; the leftover routes stay in
  `annotations[]`.
