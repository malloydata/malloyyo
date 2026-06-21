# Spec: `describe_source` output (v5 — locked)

## Design objective

Optimize for **easy and correct inference by an MCP client (an LLM)** — not for
the cleanest mathematical description of the source. The operative rule when any
question comes up:

> **Make the reader *read* the answer, never *derive* it.** Prefer an explicit
> signal over an elegant encoding; prefer local completeness over normalization.
> Redundancy that reinforces a correct inference is a feature.

The anti-pattern we're avoiding: if the client must make a follow-up call (or
scan/assemble) to learn something, it will often instead *guess* — and write a
query that errors or silently computes the wrong thing.

## Columns vs. joins (the core split)

A source has **columns** (the data in its rows) and **joins** (relationships to
other sources). They are represented differently:

- **Columns** appear in the schema's `dimensions` map:
  - **scalar** → `{ "type": "<scalar>", …meta }`
  - **single record** → `{ "type": { <name>: <descriptor>, … }, …meta }` (inline,
    recursive; a record never fans, so it's fully and locally described here)
  - **array** (scalar array or array of records) → a **stub**:
    `{ "is_array": true, "fans_out": true, "path": "<path-to-it>" }` (no `type`). The stub says
    "this column is an array; its detail is the `joins` entry at `path`."
- **Joins** appear only in the flat `joins` list (see below). A source-join is
  **not a column** — it is never stubbed in `dimensions`. (`orders.order_items`
  is a relationship, not a field; don't make it look like one.)

So `dimensions` always tells you every column the source has — scalars and
records in full, arrays as one-line stubs pointing at their detail.

## The field descriptor (scalars + records)

```
descriptor = { "type": <TypeExpr>, "must_quote"?: true,
               "expression"?: string, "description"?: string, "instructions"?: string }

TypeExpr =
  | "<scalar>"                       // "string" | "number" | "date" | "timestamp" | "boolean" | …
  | { "<name>": <descriptor>, … }    // a record — named sub-fields, each a full descriptor
```

**`type` is always a real type** — a scalar name or a record object — never a
sentinel. A member with **no `type`** is therefore unambiguously a navigable
stub: `{ is_array: true, fans_out: true, path }` (array column) or `{ source, path }`
(source-join, only used when one schema references another — see joined sources).
"No `type`" uniformly means "the shape isn't here; follow the path."

- **`dimensions`** and **`measures`** are two maps (group-by vs aggregate), same
  descriptor shape. A measure's `type` is ~always `number`; its load-bearing
  field is `expression` (`"count()"`, `"sum(weight_kg)"`). Derived dimensions
  carry `expression` the same way.
- **`views`** is `name → one-line description` (the value is `null` when the view
  has no `#"` doc — not `""`, so "no description" is distinguishable; the view is
  still listed so it stays invocable). Appears on **only the described source**
  (a view is invoked as `source -> view`, never via a join).

## Identifier quoting

**Keys stay CLEAN** (the bare name / dotted path — good for lookup, matching,
prefix-scanning). The paste-ready quoted form is *handed over* when needed, so the
consumer never stitches backticks (quote only when needed — a backtick is a rare,
meaningful signal):

- a **dimension / measure / record-subfield** key is bare, with a
  `"must_quote": true` flag when its (single) name needs backticking.
- a **`joins`** key is the bare dotted path; when some segment needs quoting the
  entry carries a paste-ready **`quoted_path`** (the assembled form — you never
  stitch backticks across a multi-segment path). Absent ⇒ the key is paste-ready.
- a **`views`** key embeds its backticks directly (its value is a description
  string, with no room for a flag).

**To write a reference:** a dimension → its key, backticked iff `must_quote`; a
join path → its `quoted_path` if present, else the key. (The error-prone part —
stitching across a multi-segment path — is always pre-assembled for you; quoting a
single field name is trivial and a wrong guess is a *loud* compile error.)

## Response shape

```jsonc
{
  "ok": true,
  "model_ref": "…",
  "source": "<name>",

  // The described source — the ONLY block with views.
  "described_source": {
    "name": "<name>",
    "primary_key": "…",
    "description": "…",
    "dimensions": { "<name>": <descriptor | array-stub>, … },  // every column
    "measures":   { "<name>": <descriptor>, … },
    "views":      { "<name>": "<one-line description> | null", … }
  },

  // Arrays and source-joins, KEYED BY PATH (null-proto; depth-first insertion).
  // Omitted when empty.
  "joins": { "<path>": <join-entry>, … },

  // Every reachable NAMED source, deduped by name. No views. Omitted when empty.
  "join_source_map": { "<name>": { "primary_key"?, "description"?,
                                     "dimensions": {…}, "measures": {…} } },

  // JUST the described source's verbatim Malloy.
  "malloy_text": "source: … is … extend { … }",

  "problems": []
}
```

## `joins` entries

`joins` is an object **keyed by the full dotted CLEAN path** from the described
source (root name NOT included; bare segments, no backticks; `.each` never appears
in a path). It's built on a null-prototype object so a reserved path is a safe
data key, and insertion order is depth-first. It holds **arrays** and
**source-joins** only (scalars and single records are columns, fully in
`dimensions`). The **key is the clean path** — a `dimensions` array-stub's `path`
points straight at it (no scanning, no guessing). To *write* the reference, use
the entry's `quoted_path` if present, else the key. Each
value carries:

- **`fans_out`** — the **total cardinality signal**: present (true) on
  EVERYTHING that multiplies rows, so the consumer's rule is one check — **"fans
  iff `fans_out` present."** It's on **array** entries (and their `dimensions`
  stubs) AND on fanning **source-joins** (a `join_many`/`cross`, or a `join_one`
  under a fanning ancestor — cumulative, AND-ed across the path). `is_array`
  answers a *different* question (what kind of thing), never cardinality — never
  make the reader derive the fan from it.
- **`cycle`: true** — present only when this re-enters a source already on its
  path; descent stops here.
- **`quoted_path`** — present only when the clean key has a segment needing
  backticks; the paste-ready form (e.g. key `rec.year` → `` rec.`year` ``). Write
  the reference from this; otherwise the key is already paste-ready.

…and **exactly one target form**:

1. **Array** — `"is_array": true`, `"fans_out": true`, `"source_def": <CompactSchema>`.
   No `code`, no `source`. A **record array**'s `source_def`
   `dimensions` are the record's fields, referenced directly (`parcels.sku`,
   `parcels.qty.sum()`). A **scalar array**'s `source_def` `dimensions` hold a
   single field **`each`** of the element type, referenced `tags.each`
   (`tags.each.sum()`). The path itself is usable **bare** as the array value
   (`array_length(parcels)`) — that's what `is_array` signals: bare value *and*
   navigate-fans.
2. **Named source-join** — `"source": "<name>"` (look it up in
   `join_source_map`) + `"code"` (the sliced join statement).
3. **Anonymous source-join** — `"source_def": <CompactSchema>` (transitive-import
   source, inline SQL/query block, extended-inline source) + `"code"`. No views.

## Recursion

Everything is recursive and obeys the same column/join split at every level:

- A **single record** column lists its own columns inline in its `type` — including
  nested array columns, which appear as stubs there (e.g.
  `origin: { type: { city: {type:"string"}, aliases: { is_array:true, fans_out:true, path:"origin.aliases" } } }`),
  with `origin.aliases` a full entry in the `joins` list.
- An **array** entry's `source_def` is itself a schema: its `dimensions` list that
  element's columns, with nested arrays again as stubs (e.g. `parcels`'s
  `source_def` has `serials: { is_array:true, fans_out:true, path:"parcels.serials" }`, and
  `parcels.serials` is its own `joins` entry).
- **Stubs everywhere a column is an array**, so a schema is always locally
  complete; the flat `joins` list is the detail index, keyed by `path`.

## Joined sources & guards

- **Full dump.** Recurse the entire join graph; `join_source_map` accumulates
  every named source reached, deduped by name. Its entries are CompactSchemas
  (their columns; no views). A named source's **array columns** are stubbed in its
  map entry — but because the source is deduped (reached via possibly many
  handles), those stubs are **relative** (`{ is_array: true, fans_out: true }`, no absolute
  `path`); the absolute paths live in the flat `joins` list under each handle.
- **Cycle guard (per path).** Re-entering a source already on the path → emit one
  entry with `cycle: true`, don't descend. Bounds each path to the number of
  distinct sources; no depth cap needed. Diamonds (same source via two different
  paths) are allowed — two entries, both in the map.
- **The anonymous wrinkle.** Inside a `source_def` subtree, an onward join to a
  **named** source is a `source` reference (added to `join_source_map`), not a
  re-dump.
- **`malloy_text`** is just the described source's own declaration.

## Locked decisions

1. **Columns in `dimensions`; joins in the flat `joins` list.** Source-joins are
   never stubbed in `dimensions` (a join is not a column).
2. **`type` is always a real type** (scalar or record). "No `type`" = a stub
   (`is_array`+`path`, or `source`+`path`).
3. **Records inline (nested `type`); arrays are a `dimensions` stub + a `joins`
   entry; scalars inline.** Records never enter the `joins` list (they don't fan).
4. **Arrays in the `joins` list**: `is_array: true`, `fans_out: true`, `source_def`
   (scalar → single `each`; record → real fields), no `code`/`source`; the path is
   usable bare.
5. **`fans_out`** is the **total cardinality signal** — present (true) on every
   fanning thing (array entries, array stubs, and fanning source-joins), absent
   otherwise. Consumer fan rule: one check, "fans iff `fans_out`." No per-hop
   `relation`.
6. **Keys are clean; the quoted form is handed over.** Dimension/measure keys are
   bare + a `must_quote` flag; `joins` keys are bare paths + a `quoted_path` (only
   when a segment needs it); view keys embed backticks. Never blanket-quote;
   never make the consumer stitch backticks across a path.
7. **`join_source_map`** is the full reachable named closure, deduped (no depth
   limit); array-column stubs in its entries are relative.
8. **Views only on `described_source`. `malloy_text` only the described source.**
9. **No `depth` parameter.**

## Acceptance criteria

- `dimensions` lists every column: scalars/records in full, arrays as
  `{ is_array, fans_out, path }` stubs; no column is discoverable only by scanning `joins`.
- No dimension `type` is ever an array or a sentinel string; "no `type`" ⇒ a stub.
- Each array has a `joins` entry (`is_array`, `fans_out`, `source_def`): record
  arrays referenced `<path>.<field>` (`parcels.sku`), scalar arrays via the single
  `each` (`tags.each`); the bare path is the array value.
- Source-joins appear only in `joins`, never as a `dimensions` stub.
- Duplicate joins to one source → two `joins` entries (distinct `path`) and one
  `join_source_map` entry.
- `fans_out: true` iff some hop is `join_many`/`cross`/array, including `join_one`
  children of a fanning ancestor.
- A named target resolves in `join_source_map` (even inside an anonymous
  subtree); an un-nameable target's fields are inline in its `source_def`.
- Views only under `described_source`; `malloy_text` is the described source only.
- A cyclic path returns; the cycle entry is marked and not descended.

## Non-goals

- No change to `list_sources`. No new request parameters.
- No per-hop `relation`, no `depth` knob, no blanket quoting, no array/sentinel
  dimension types, no source-join stubs in `dimensions`.
