# @malloyyo/mcp-engine

The shared Malloy MCP engine — vendor-neutral types, helpers, and turnkey
tool surfaces consumed by both the malloyyo server (`/mcp`) and the malloyyo
CLI (`malloyyo mcp`). **Design: [`docs/mcp-engine.md`](../../docs/mcp-engine.md)**
(read it first; the principles there decide ties). Private workspace package,
extractable to `@malloydata/*` later.

## Three layers

1. **types** — the wire contract (`ModelInfo`, the describe-shape,
   `problems[]`, result envelopes). snake_case keys; `description` always
   emitted (null = signal); develop-only fields (`location`, `body`, `entry`)
   are stripped by the explore projection.
2. **helpers** — pure functions over an **injected `malloy.Runtime`**:
   `compile` (the walker), `selectSource`/`describeSource`, `run`,
   `validateRestricted`/`runRestricted`, `prettify`, `prepareSource`,
   `language_help` lookups. Never construct runtimes, never touch fs/DB,
   never throw on user-input failure.
3. **turnkey surfaces** — `developSurface(host)` / `exploreSurface(host)`
   produce tools-as-data (`{name, description, inputSchema (JSON Schema),
   handler}`); hosts decorate by mapping over the records and serialize via
   `toContent`. `mergeSurfaces` composes them (fox-mode). Construction does
   zero I/O.

## What hosts provide

```ts
// explore (e.g. hosted /mcp, built per request around the principal)
const host: ExploreHost = {
  withModel: (ref, fn) => /* resolve ref → lease pooled runtime → fn → release */,
  list:      (req) => /* OPTIONAL advisory paged catalog view */,
};
const surface = exploreSurface(host, { result: { spill: persistAndLink } });

// develop (e.g. fox CLI over cwd)
const host: DevelopHost = {
  withRuntime: async (input, fn) => {
    const { reader, entry, readSource } = prepareSource(myFsReader, input);
    const rt = new Runtime({ config, urlReader: reader });
    try { return await fn({ runtime: rt, entry, readSource }); }
    finally { await config.shutdown('idle'); }
  },
};
```

SDK hosts attach via the optional subpath (`@modelcontextprotocol/sdk` is an
optional peer; tools go through the low-level handlers so JSON Schema is used
verbatim):

```ts
import { attachSurface } from '@malloyyo/mcp-engine/mcp-sdk';
attachSurface(server, surface, { registerSkillsAsPrompts: true });
```

## Build & test

```bash
npm run gen        # content/*.md → src/content/generated.ts (no runtime fs reads)
npm run typecheck
npm run test       # node:test via tsx; needs DuckDB (devDep) for real compiles
npm run build      # esbuild ESM bundle + d.ts
UPDATE_GOLDENS=1 npm run test   # refreeze walker goldens after an intentional change
```

The golden files under `test/golden/` are the describe-shape contract in
example form — review diffs to them like API changes, because they are.

## Dependency rules (load-bearing)

- `@malloydata/malloy` is a **peerDependency, never bundled** — Runtimes
  cross the package boundary and the error path does `instanceof
  MalloyError`; two copies would degrade every compile error to
  `internal-error`.
- No regular runtime dependencies. Content is embedded as strings at build
  time (`npm run gen`), so the package does zero file I/O at runtime.
