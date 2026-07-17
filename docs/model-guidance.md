# Model-contributed guidance & the raw-query escape hatch

Two extensions to the explore surface that let a **model repo** — not the engine, not the
host — carry the domain knowledge its consumers need. Both are data-driven: the mechanism
lives in the engine; every word of content lives in the model repo and travels with
publish/refresh.

## Why (the gap they close)

The explore surface teaches a client *how to query* — `list_sources` → `describe_source` →
`query`, with the compiler as oracle. What it cannot teach is the **domain**: which of two
category hierarchies wins, what a retired word like "gross" must translate to, which join
level is safe. Source/measure annotations carry some of this, but they are fragmentary by
nature — attached to one field, invisible until the right describe. Live evals showed the
cost concretely: on a published retail model, a capable client (Sonnet) answered 15/15 trap
questions from annotations alone, while a small one (Haiku) refused or answered wrong
whenever the ruling lived nowhere it looked. Rulings need a **prose channel** that survives
the smallest client.

## Model-contributed guidance topics

A model repo may ship markdown topics under `guidance/` next to `index.malloy`:

```
my-model/
  index.malloy
  malloy-config.json
  guidance/
    sales.md          # ---\ndescription: one-liner for indexes\n--- + the ruling
    category.md
```

- **Ingestion**: `malloyyo publish` gathers `guidance/**/*.md` with the model files;
  the GitHub-refresh path fetches the same tree. They ride the existing per-version
  model-file storage — no schema change, versioned with the model.
- **Serving**: topics fold into `yo_help` (the one channel every host has — see
  [explore-surface.md](./explore-surface.md), "Delivery model"). The topic name is the file
  path (help.ts's rule): `guidance/sales.md` → `guidance/sales`. A multi-model host prefixes
  the model_ref (`shop/guidance/sales`); yo_help's substring rung still resolves the short
  name.
- **Announcement** (pointers, not cargo — the delivery-model rules):
  - an instructions lead-block indexes the topics (name + front-matter description);
  - the host decorates the model's `list_sources` entry with a read-first pointer — the
    reliable tool-RESULT channel;
  - `yo_help`'s description notes that model topics exist.
- The local CLI test window (`malloyyo mcp`) serves `./guidance/**` the same way, so what
  you test is what a hosted consumer gets.

## The raw-query escape hatch (`run_query`)

Some models' guidance speaks SQL — canonical patterns over warehouse tables the Malloy
sources don't (yet) cover. For those, the model AUTHOR may enable a raw-query tool:

```json
// malloy-config.json (top level, same precedent as poolSize)
{ "connections": { ... }, "rawQuery": true }
```

- Executes **one read-only SQL statement** (SELECT/WITH/FROM) on the **model's own
  connection** — the same pooled connection its queries use; no new credentials.
- Gated in the engine (`sql-guard.ts`): comments stripped first, single statement only,
  write/DDL verb blocklist that errs toward refusal (a pure SELECT mentioning "update"
  is rejected with a rephrase hint).
- Never on by default; absent entirely unless a visible model opts in. Enabling it widens
  the surface from "the published sources" to "whatever the connection can read" — opt in
  only when the connection's own scope IS the intended surface.
- Hosted calls are audited to history like queries (SQL in the audit column); no share
  slug (ltool renders Malloy).

## Design stances

- **Mechanism in the engine, content in the model repo.** No instance-specific strings in
  engine or host code; a fork-free instance gets both features by publishing files.
- **Guidance leads, canon trails.** The guidance block is a lead instruction block, so
  `mergeSurfaces` still collapses the shared canon across surfaces.
- **Same delivery rules as everything else.** Load-bearing text rides yo_help + tool
  results; `instructions` carries only the index; tool descriptions carry mechanics.
