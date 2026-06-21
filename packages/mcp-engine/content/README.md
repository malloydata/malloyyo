# The content tree — TL;DR

All the engine's model-facing prose lives here and is **embedded at build time**
into `src/content/generated.ts` (generated, gitignored — never edit it). Edit the
markdown, then run `npm test` or `npm run build` (both re-embed automatically).
`README.md` is the one file here that does NOT ship — it's these notes.

## Two zones

**`prompts/**` — the typed prompt tree.** Tool titles/descriptions + per-surface
server instructions. The path IS the key:

```
prompts/explore/tools/describe_source/description.md → prompts.explore.tools.describe_source.description
prompts/explore/instructions.md                      → prompts.explore.instructions
prompts/core/instructions.md                         → shared canon, appended to every surface
prompts/shared/...                                   → tools/errors reused across surfaces
```

Code reads these only through the typed `prompts` tree (`src/prompts.ts`), never
by string. The tree is `as const`, so a renamed/missing file is a **compile
error**, not a silent empty string.

**`help/**` — `yo_help` topics, namespaced by directory.** Every `.md` under
`help/` becomes a `yo_help` topic automatically, and **the topic's name IS its
path** (slug = path, each segment lowercased):

```
help/explore/how-to.md → yo_help("explore/how-to")
help/language/joins.md         → yo_help("language/joins")
help/writing-malloy-with-mcp.md → yo_help("writing-malloy-with-mcp")  (root = no namespace)
```

The directory layout IS the namespace (`explore/`, `develop/`, `language/`, …).
A new category is just a new directory — it appears with no code change. There
is **one name per topic, no title** — front-matter `description:` is no longer
surfaced (fine to drop it). The one special file is
`help/language/malloy-language-reference.md`: a vendored whole doc, split into one
topic per `##` heading under its `language/` namespace.

## Rules that bite

- **Description/title files are single-line and verbatim** — exactly the bytes
  in the file ship. Keep them short (1–2 lines); behavioral policy belongs in the
  surface `instructions.md`, not stuffed per-tool (short descriptions rank better
  in the client's tool search).
- **`instructions.md` keeps its line breaks.** A surface ships its own block +
  `core/instructions.md`.
- **2KB cap.** Claude Code truncates a server's `instructions` at ~2048 bytes.
  `gen` prints each surface's size and flags anything over. Watch that number when
  you edit an `instructions.md`.
- **Reachability:** every piece of guidance must be reachable via `yo_help` — the
  hosted `/mcp` has no prompts/resources capability, so `yo_help` is the one
  channel every host has. New guidance goes in a `help/<area>/<name>.md` (auto-listed).
- **Error → topic** wiring lives in `src/help.ts` `ERROR_TOPIC_MAP` (a compiler
  error `code` → a topic name, e.g. `language/fields`), so a `problems[]` entry
  can point at its fix.

## Common edits

| Want to… | Edit | Then |
|---|---|---|
| Reword a tool description | `prompts/<surface>/tools/<tool>/description.md` (one line) | `npm test` |
| Change a surface's instructions | `prompts/<surface>/instructions.md` (+ `core/` for shared) | watch the 2KB size |
| Add a `yo_help` topic | new `help/<area>/<name>.md` | auto-listed (name = its path) |
| Rename a tool's prompt key | rename the directory | stale refs become compile errors |

Not here yet (still inline in `src/`, a deliberate fast-follow): input-schema
**param descriptions** and the dynamic **nudge/error strings**. They don't count
toward the 2KB cap, so they were left for a later pass.
