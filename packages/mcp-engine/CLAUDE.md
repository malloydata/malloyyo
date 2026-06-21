# mcp-engine — agent notes

Read `README.md` for what this package is; read `../../docs/mcp-engine.md`
(the design) before changing any API — its principles section decides ties,
and its decisions record explains why things are the way they are.

Rules specific to this package:

- **The golden files (`test/golden/*.json`) are the wire contract in example
  form.** Treat diffs to them as API changes, not test noise. After an
  intentional shape change: `UPDATE_GOLDENS=1 npm run test`, then review the
  golden diff like you'd review a public API diff.
- **`src/content/generated.ts` is generated** (`npm run gen`, from
  `content/*.md` and `content/prompts/**.md`) and gitignored. Edit the markdown
  in `content/`, never the generated file. `test` and `build` both run gen
  automatically.
- **All model-facing prose lives in `content/prompts/**.md`, not inline in
  `src/`.** Tool titles/descriptions and the per-surface server instructions
  are edited there as plain text (the human audit/edit surface) and read in code
  via the typed tree `prompts.<surface>.tools.<tool>.{title,description}` /
  `prompts.<surface>.instructions` from `src/prompts.ts` (the sole accessor —
  no stringly-keyed lookup). The tree mirrors the path: `content/prompts/develop/
  tools/compile/description.md` → `prompts.develop.tools.compile.description`.
  A renamed/missing key is a **compile error** (the tree is `as const`).
  Description files are single-line (verbatim — what's in the file ships);
  instruction files keep their line breaks. gen prints each surface's assembled
  instruction size and flags anything over the 2KB Claude Code cap.
  *Not yet externalized (still inline, fast-follow): param descriptions and the
  dynamic nudge/refusal/error strings.*
- **Do not add runtime dependencies.** `@malloydata/malloy` stays a
  peerDependency (Runtimes and `instanceof MalloyError` cross the package
  boundary — a second copy breaks error mapping). The MCP SDK is an optional
  peer touched only by `src/mcp-sdk.ts`.
- **Helpers never throw on user-input failure** — failures return as
  `problems[]`. Only programmer misuse throws. Keep it that way.
- **No fs/DB reads in `src/`** (tests may read fixtures). The host supplies
  readers; content is embedded at build time.
- Build goes through `scripts/build.mjs` (esbuild JS API), not the esbuild
  CLI bin — pnpm lays the bin shim out inconsistently across installs.
- Tests are `node:test` via tsx and use real DuckDB compiles; run them from
  this directory: `npm run test`.
