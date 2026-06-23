# The explore surface — flow and design

The explore surface lets a consumer — typically a client LLM like claude.ai — run
analytical queries against a **published Malloy semantic model** it did not write.
The model exposes curated sources (dimensions, measures, views, joins); the
consumer composes queries over them; Malloy runs them on the model's own engine
(DuckDB by default; the model can attach its own warehouse).

This doc is the design home for the explore experience: the delivery model (which
document the client actually reads, and why), the flow, the tools, and the
standing design stances. Wire-level detail lives in
[`describe-source.md`](./describe-source.md) and [`describe-shape.md`](./describe-shape.md);
the engine design in [`mcp-engine.md`](./mcp-engine.md).

## One engine, two hosts

`exploreSurface` lives in `packages/mcp-engine` and is consumed by two thin hosts:

- the **local CLI** — `malloyyo mcp --explore` (`packages/cli/src/mcp.ts`),
- the **hosted `/mcp`** endpoint claude.ai connects to (`src/lib/mcp-host.ts`).

Change the engine surface and both move together — no second copy to drift. The
CLI host is also how the surface gets field-tested against real models before
anything ships hosted.

## Delivery model — what the client reads, and why (load-bearing)

The single most important design fact about this surface is **which channel the
guidance rides on.** Of the channels MCP offers, only some are reliable:

- **Reliable: tool descriptions** (read at cold start) and **tool results** (read
  after every call). The client always sees these.
- **Reliable on demand: `yo_help`** — the client pulls it, reactively, exactly
  when it needs it (an error's `help_topic`, or an explicit topic lookup). A
  session that needs guidance *will* reach it.
- **NOT reliable: the MCP `instructions` string, prompts, resources.** There is
  **no guarantee a given session ever sees `instructions`** — it's best-effort,
  capped (~2KB in Claude Code), and frequently ignored by clients.

Three consequences, and they are the rules for this surface:

1. **`content/help/explore/how-to.md` is the load-bearing document.** It is *what
   we want clients to read* — the methodology and the flow: compose-don't-fake,
   validate-first, aggregate-in-Malloy, present-results-this-way, and the
   describe → query → run → display loop. It is delivered as the
   `yo_help("explore/how-to")` topic, and pointed at from tool results and error
   `help_topic`s. **This is the single source of truth for the methodology** —
   change your mind here, in one place, and every pointer keeps working.

2. **`content/prompts/explore/instructions.md` is intentionally near-empty.**
   Because the `instructions` channel may never be seen, it must carry **nothing
   load-bearing** — at most a one-line "this is Malloy analytics; start with
   `list_sources`/`describe_source`; every result points you to `yo_help`." Do not
   put methodology, workflow, or rules here. Treating `instructions` as real
   estate is the mistake; it's a wasteland we don't rely on.

3. **Methodology stays singular; everything else only *points* at it.** Tool
   descriptions carry per-tool *mechanics* (params, response shape, what maps to
   the next call, the one narrow contract rule). They do **not** restate the
   cross-cutting methodology — that stays in `how-to.md`. Mechanics on the tool;
   methodology in the one doc; the unreliable channels carry pointers, not cargo.

## The flow (the loop a client runs)

1. **Orient** — `list_sources`: what sources exist (grouped by model, with named
   queries). If the source is already known, skip straight to describe.
2. **Map** — `describe_source` on the chosen source: its typed columns, measures,
   views, and the joins it reaches (fan-out flagged). Read the answer; don't guess
   field or join names.
3. **Validate** — write Malloy, call `query` with `execute:false` to compile-check
   and inspect the SQL cheaply. Iterate until clean.
4. **Run** — `query` with a plain-English `question` describing what *that* query
   answers; get rows + the generated SQL.
5. **Share** (optional) — `open_share_link` mints an ltool link to reopen/hand off
   the result.

Throughout, **the compiler is the oracle.** Correctness is enforced by
compile-in-the-loop (`problems[]` + help-on-error), not by trying to make
`describe_source` so complete the client never errs. Describe is a map; the
compiler is ground truth.

## The tools

- **`list_sources`** — cheap catalog entry point; "what can I ask about?"
- **`describe_source`** — the typed, join-aware map of one source (source-first;
  `model_ref` optional disambiguation). The world-class data spine; never regress
  it to a typeless/join-blind shape.
- **`query`** — `execute:false` validates (SQL + `problems[]`); default runs
  (byte-budgeted rows + SQL). Compose new dimensions/measures/sources/joins from
  the model's sources — the consumer is not limited to the author's fields.
- **`yo_help`** — topic help, including the load-bearing `explore/how-to`; errors
  carry a `help_topic` so guidance arrives reactively.
- **`open_share_link`** — mints the shareable ltool link for a result.

## Design stances worth knowing

- **Source-first, model-centric only where needed.** Discovery and queries are by
  source. A pure model-centric query path was tried and reverted — it broke on
  extended sources.
- **"Throw everything cheap" on describe.** One fat, locally-complete describe
  beats many drill-down round-trips for an agent. Redundancy that reinforces a
  correct inference is a feature. (Revisit only if real sessions show describes
  crowding context.)
- **Code is never buried in JSON.** Malloy text and generated SQL ride in their
  own content blocks, never escaped inside a JSON field.
- **Restricted mode is reactive, never proactive.** Explore compiles in Malloy's
  restricted mode (no imports, no raw table/SQL, no new givens). The guidance
  stays *silent* about this — a proactive warning made clients overcautious. The
  restriction surfaces only when a query trips it, via the error → help topic.
- **Annotations split into two channels.** A `description` (human/agent-facing doc
  comment) plus a structured `annotations[]` for other routes (e.g. agent-only
  notes). The fox curates these on the model; the surface projects them per
  channel.
- **Aggregate in Malloy; byte-budget the rows.** Ranking, top-N, and member
  selection happen in Malloy, not in client code; oversized results spill rather
  than flood context.

## Known open friction

The query experience is strong; the rough edges are discovery framing and a few
Malloy-codegen sharp edges surfaced by live use:

- nested-join references inside `ON` clauses can compile but fail at execution —
  the surface should reject them at compile time;
- a pipelined source with no terminal `run:` is misdiagnosed as a compiler bug
  instead of "add a `run:`";
- silent join-name collisions with inherited joins want a clearer hint.

## Pointers

- **Client-facing flow + methodology (canonical, shipped):**
  `packages/mcp-engine/content/help/explore/how-to.md` (the `yo_help("explore/how-to")` topic).
- **Surface rails (intentionally minimal):**
  `packages/mcp-engine/content/prompts/explore/instructions.md`.
- **Describe wire shape:** [`describe-source.md`](./describe-source.md), [`describe-shape.md`](./describe-shape.md).
- **Engine design:** [`mcp-engine.md`](./mcp-engine.md).
