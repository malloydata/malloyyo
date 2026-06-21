# The shared MCP engine — design

**Status:** IMPLEMENTED. The engine is `packages/mcp-engine` (all three layers,
with walker goldens and a live SDK round-trip); the local explore server is
`malloyyo mcp` (`packages/cli/src/mcp.ts`); the hosted `/mcp` runs on the engine
via `src/lib/mcp-host.ts`. This doc is the normative design; the decisions log
records what implementation taught.
Companion to
[`describe-shape.md`](./describe-shape.md) — the types below are the normative
TS rendering of the describe-shape, with extensions noted in §Decisions.
The **explore `describe_source` tool output** is now a further projection with its
own current spec, [`describe-source.md`](./describe-source.md) (v5):
`described_source` + path-keyed `joins` + deduped `join_source_map`, the
columns-vs-joins split, `fans_out`, and `quoted_path`.

**Reference material for the implementer:**
- `~/malloy-cli/src/mcp/{server,compile,run,restricted,loader,help,skills}.ts` —
  the semantic reference. Port the *logic*; the plumbing changes per this design.
- `~/yo/src/lib/malloy.ts`, `src/lib/mcp-tools.ts`, `src/app/mcp/route.ts` —
  the hosted explore endpoint this engine replaces the core of.
- `docs/model-publishing-design.md` — Lloyd's shipped push design (workspace
  packaging precedent, `MapURLReader`).

---

## Vocabulary

- **surfaces:** `develop` | `explore` — the MCP tool restriction. (The words
  *author* and *consumer* are retired; earlier drafts and the malloy-cli
  reference use them.)
- **where:** `local` | `server` — which side a surface runs.
- **modes a fox names:** *developer* = develop+local; *test* = explore+local;
  *production* = explore+server. The load-bearing line: **"test = the explore
  surface, run local."**
- **actions (kept separate):** *publish* / *deploy*.

## Architecture in one paragraph

A private workspace package exporting three layers: **types** (the wire
contract), **helpers** (pure functions over an injected `malloy.Runtime`), and
**turnkey surfaces** (ready-made `develop`/`explore` tool sets, produced as
*data + handlers*, attachable to any transport). Hosts own runtime
construction, connection lifecycle, bindings, identity/auth, and transport.
The library is pure logic plus bundled language-reference content.

## Principles (established during design; they decide ties)

1. **Zero-I/O construction.** Instantiating a surface is pure closures over
   config/identity. No scanning, listing, or compiling happens until a tool
   call. Consequences: O(1) resolution, tree-size irrelevance, per-request
   principal-bound hosts are cheap, lifecycle stays out of the engine.
2. **Resolution is the primitive; enumeration is advisory.** `withModel(ref)`
   must work as one lookup. `list` is optional, paged, *partial* — it carries
   no completeness guarantee (`next_cursor` exhaustion means "end of this
   view," not "end of the catalog"). Absent `list`, the server's instructions
   explain how refs are formed (self-description as graceful degradation).
3. **The model is the engine's addressable unit** — because it is the
   compilation unit: `withModel(ref)` is model-keyed, and a restricted query
   compiles against a model and may reference any source or named query in it.
   The explore SURFACE layered on top is **source-centric** (main's interaction):
   `list_sources` discovers sources, and `describe_source`/`query` take a bare
   `source`, resolving it to its model (with `model_ref` to disambiguate). So
   discovery is source-first while addressing stays model-keyed underneath —
   resolution maps one to the other. (Earlier drafts argued against source-first
   flattening; main chose it for the surface deliberately.)
4. **Context is the budget.** The agent reading responses is an LLM. Row limits bound memory,
   not context (Malloy results nest). Responses are byte-budgeted at
   serialization; completeness belongs in an artifact (spill → link), not in
   context; degradation always says what happened and how to get more.
5. **Compiler is ground truth; discovery on demand.** Givens illustrate the
   pattern: declarations are knowable at model scope, requirements only at
   compiled-query scope — so the engine answers each question only where it is
   authoritative, and the agent learns needs from the compile loop, not from
   eager inventories.
6. **Problems are data, not protocol errors.** Every helper/tool failure that
   the agent can act on comes back as `problems[]` with codes, positions, and
   `help_topic` pointers. `isError`/protocol errors are reserved for the host
   (auth, unknown tool).
7. **Guidance is engine content** — "how to write Malloy over MCP" is part of
   the product, identical for every host (§Guidance).

## Layer 1 — types (the wire contract)

**`packages/mcp-engine/src/types.ts` is authoritative for exact field shapes;**
the blocks below are illustrative and may lag it. Two deltas the implementation
settled that these renderings predate: (1) `description`/`instructions` and the
other optional fields are **omitted when absent**, never `null` (only
`primary_key` is `string | null`); (2) annotations split into **two promoted
channels** — `#"` → `description`, `#(agent)` → `instructions` — plus a
`must_quote` flag on every name written in Malloy.

Wire keys are `snake_case` throughout. TS-side option bags use camelCase.

```ts
// ── primitives ─────────────────────────────────────────────────────

/** [line, column], 0-based, start only. Develop surface only. */
export type Loc = [number, number];

export interface Annotation { route: string; text: string }

export interface Problem {
  severity: 'error' | 'warn' | 'debug';
  message: string;
  code: string;                  // malloy's stable error code
  uri?: string;
  line?: number; column?: number; end_line?: number; end_column?: number;
  /** Set when `code` maps to a yo_help topic. */
  help_topic?: string;
}

// ── the describe-shape ─────────────────────────────────────────────

export interface FieldInfo {
  name: string;
  type: string;                  // malloy atomic type
  expression?: string;           // only when it differs from the name
  description: string | null;    // promoted from the `#"` annotation route
  annotations?: Annotation[];
  location?: Loc;                // develop projection only
}

export interface ViewInfo {
  name: string;
  description: string | null;
  annotations?: Annotation[];
  location?: Loc;                // develop only
  body?: string;                 // develop only; only when readSource available
}

export interface JoinInfo {
  name: string;
  relationship: 'one_to_many' | 'many_to_one' | 'cross';
  source_ref?: string;           // nameable target → look up in `sources`
  anon_src_index?: number;       // un-nameable target (transitive import) →
                                 // index into the owning source's `anon_srcs`
  /** Inline groups when the target defines its own shape (nested/repeated
      record, SQL/query/extended source), or when expand:'inline' was forced.
      Invariant: source_ref ∪ anon_src_index ∪ fields. */
  fields?: FieldGroups;
  description: string | null;
  annotations?: Annotation[];
  location?: Loc;                // develop only
}

export interface FieldGroups {
  dimensions: FieldInfo[];
  measures: FieldInfo[];
  views: ViewInfo[];
  joins: JoinInfo[];
}

export interface SourceInfo extends FieldGroups {
  name: string;
  description: string | null;
  primary_key: string | null;
  annotations?: Annotation[];
  location?: Loc;                // develop only
  anon_srcs?: SourceInfo[];      // un-nameable join targets (see JoinInfo.anon_src_index)
}

// ── model level (canonical walker output) ──────────────────────────

export interface GivenInfo {
  name: string;                  // surface name, no `$`
  type: string;                  // "string", "date", "filter<timestamp>", "record[]" …
  has_default: boolean;
  description: string | null;
  annotations?: Annotation[];
  location?: Loc;                // develop only
  body?: string;                 // develop only
}

export interface NamedQueryInfo {
  name: string;
  description: string | null;
  annotations?: Annotation[];
  /** Transitive given names this query references (authoritative at query scope). */
  givens?: string[];
  location?: Loc;                // develop only
  body?: string;                 // develop only
}

export interface RunStatementInfo {
  index: number;                 // 0-based among run: statements
  annotations?: Annotation[];
  givens?: string[];
  location?: Loc;                // develop only
  sql?: string;                  // only when emitRunSql requested
  error?: string;                // SQL generation failed for this run only
}

export interface ModelInfo {
  entry?: string;                // root URI — develop only (leaky on explore)
  annotations?: Annotation[];
  givens?: GivenInfo[];          // declarations — model scope is authoritative
  sources: Record<string, SourceInfo>;  // also the lookup table for source_ref
  queries: NamedQueryInfo[];
  runs: RunStatementInfo[];
}

/** describe-source selection: requested + deduped transitive join closure.
    NO givens here — sources are not an authoritative given scope. */
export interface SourceDescription {
  requested: string;
  sources: Record<string, SourceInfo>;
}

// ── result envelopes ───────────────────────────────────────────────

export interface CompileResult {
  ok: boolean;                   // false ⇒ model absent, ≥1 error in problems
  model?: ModelInfo;
  /** Entry source already in the prettifier's canonical form? false ⇒
      prettify before saving. One token instead of echoing prettified text.
      Omitted when unjudgeable: no readSource, or parse errors. */
  formatted?: boolean;
  problems: Problem[];
}

export interface QueryValidationResult {
  ok: boolean;
  problems: Problem[];
  /** Givens this query transitively references — FULL detail, so the caller
      can supply values without another lookup. Authoritative (per-query). */
  givens?: GivenInfo[];
}

export interface RunResult {
  ok: boolean;
  sql?: string;
  rows?: unknown[];
  row_count?: number;            // rows the query produced (≤ rowLimit)
  rows_returned?: number;        // rows actually present after budgeting
  truncated?: {
    reason: 'row_limit' | 'byte_budget';
    full_result?: string;        // where the host spilled the complete result
    hint: string;                // actionable: aggregate / top-N in Malloy / project less
  };
  compile_time_ms?: number;
  total_time_ms?: number;
  /** interfaces-format result (API.util.wrapResult) — host renderers only,
      populated on request, never sent over MCP. */
  stable_result?: unknown;
  problems: Problem[];
}

// ── surface projection (pure; the walker always emits the full shape) ──

export type Surface = 'develop' | 'explore';
// explore projection strips: location, body, entry, runs.
// keeps: expression, description, annotations, queries, givens.
export function projectModel(m: ModelInfo, surface: Surface): ModelInfo;
export function projectDescription(d: SourceDescription, surface: Surface): SourceDescription;

// ── catalog entry (advisory list) ──────────────────────────────────

export interface ModelEntry {
  ref: string;                   // host-defined: dataset name, relative path, …
  description: string | null;
  /** Advisory hints when the host knows them cheaply (e.g. stored at publish).
      Never required, never guaranteed complete. */
  sources?: string[];
  queries?: string[];
}
```

## Layer 2 — helpers (pure functions over an injected Runtime)

Helpers never construct runtimes, never touch fs/DB, never throw on
user-input failure (everything actionable returns as `problems`; only
programmer misuse throws). `@malloydata/malloy` types (`Runtime`,
`URLReader`, `GivenValue`, `LogMessage`) come from the host's copy (§Package).

```ts
// ── compile / describe ─────────────────────────────────────────────

export interface CompileOptions {
  /** Re-read source text by href, for body slicing. Absent → bodies omitted. */
  readSource?: (href: string) => string | undefined;
  expand?: 'ref' | 'inline';     // join rendering; default 'ref'
  emitRunSql?: boolean;          // default false (large, rarely needed)
}

/** The one walker: compile a model, return its full structured description
    (develop shape; apply projectModel for the explore surface). */
export function compile(runtime: Runtime, entry: URL, opts?: CompileOptions):
  Promise<CompileResult>;

/** Pure selection: requested source + transitive join closure. No I/O.
    The closure comes from the single compiled model — never from discovery. */
export function selectSource(model: ModelInfo, name: string):
  SourceDescription | undefined;

export interface DescribeResult {
  ok: boolean;
  description?: SourceDescription;
  problems: Problem[];           // compile failure, or 'source-not-found'
}                                // (message lists the names that DO exist)

/** Convenience: compile + selectSource. */
export function describeSource(runtime: Runtime, entry: URL, name: string,
  opts?: CompileOptions): Promise<DescribeResult>;

// ── execution (open / develop) ──────────────────────────────────────

export interface RunOptions {
  name?: string;                 // a query: definition — wins
  index?: number;                // else 0-based into run: statements
                                 // else: the final run:
  rowLimit?: number;             // default 10_000 (memory/transfer cap, not context)
  givens?: Record<string, GivenValue>;
  stableResult?: boolean;        // attach stable_result for host renderers
  /** Wrap execution (e.g. DuckDB file-lock retry). Default: run once. */
  retry?: <T>(op: () => Promise<T>) => Promise<T>;
}

export function run(runtime: Runtime, entry: URL, opts?: RunOptions):
  Promise<RunResult>;
// selection failures: problems codes 'selector-not-found' /
// 'selector-out-of-range' / 'no-run', message listing what is available.

// ── execution (restricted / explore) ──────────────────────────────
// Both enforce core's loadRestrictedQuery: no import, no given: declarations,
// no connection.table/sql, no raw-SQL forms, no ##! flags →
// 'restricted-construct-forbidden'. "Restricted" stays in the names so an
// implementer cannot silently route explore-surface input through the open run.

export function validateRestricted(runtime: Runtime, entry: URL, query: string):
  Promise<QueryValidationResult>;

export function runRestricted(runtime: Runtime, entry: URL, query: string,
  opts?: Pick<RunOptions, 'rowLimit' | 'givens' | 'stableResult' | 'retry'>):
  Promise<RunResult>;

// ── language help (bundled content, §Content) ──────────────────────

export function listHelpTopics(): Array<{ slug: string; title: string }>;
export function getHelpTopic(query: string): HelpTopic | undefined; // slug→title→substring
export function helpTopicForCode(code: string): string | undefined; // problems[] decoration

// ── misc pure helpers ──────────────────────────────────────────────

export function prettify(source: string):
  { formatted: string; problems: Problem[] };   // best-effort when problems non-empty

export function mapProblems(log: LogMessage[]): Problem[];  // + help_topic decoration
export function errorProblem(e: unknown, uri?: string): Problem;

// ── reader conventions ─────────────────────────────────────────────
// The host builds the Runtime; this builds what the host builds it FROM.
// Owns malloy-cli loader.ts's conventions (virtual URLs for inline sources,
// caching so text is re-readable) over a host-supplied base reader (fs, map,
// DB-backed). The library itself never reads fs/DB.

export type SourceInput = { url: string } | { source: string; baseUrl?: string };

export function prepareSource(base: URLReader, input: SourceInput): {
  reader: URLReader;
  entry: URL;
  readSource: (href: string) => string | undefined;
};
```

A host's whole compile path:

```ts
const { reader, entry, readSource } = prepareSource(myFsOrMapReader, input);
const rt = new Runtime({ config, urlReader: reader });  // native Malloy, host-owned
const result = await compile(rt, entry, { readSource });
```

(Constructor verified against the installed `@malloydata/malloy`: the options
bag is `{ urlReader?, connections?, connection?, config?, buildManifest?,
eventStream?, cacheManager?, givens? }` — `cacheManager` and per-runtime
`givens` are further host levers, reinforcing the injection boundary.)

**Don't pay for bodies you'll discard:** when a describe is explore-bound,
omit `readSource` — body slicing is the only thing it feeds, and the explore
projection strips bodies anyway. Bodies degrade gracefully by design, so this
is free.

**Nudge layering:** helpers decorate problems only mechanically (`help_topic`
from the code map). Wording that names *tools* ("call `describe_model` to see
what exists") lives in the turnkey handlers, which know their own tool names.

## Layer 3 — host contracts & turnkey surfaces

### Host contracts (what you plug in)

```ts
export interface BoundModel {
  runtime: Runtime;
  entry: URL;
  readSource?: (href: string) => string | undefined;
}

/** Explore side. ref is host-defined (dataset name for malloyyo, relative
    path for a directory host). withModel is a LEASE: acquire/release brackets
    the call — pooling, idling, per-call cleanup all live in the host's
    finally. Identity is closed over (build a host per request). */
export interface ExploreHost {
  withModel<T>(ref: string, fn: (m: BoundModel) => Promise<T>): Promise<T>;
  list?(req: { cursor?: string; limit?: number; query?: string }):
    Promise<{ entries: ModelEntry[]; next_cursor?: string }>;
}

/** Develop side: per-call lease over arbitrary input.
    Typical impl: prepareSource → new Runtime → fn → finally idle/close. */
export interface DevelopHost {
  withRuntime<T>(input: SourceInput, fn: (m: BoundModel) => Promise<T>): Promise<T>;
}
```

### What you get back

```ts
export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;  // plain JSON Schema — the wire format
  handler: (args: Record<string, unknown>) => Promise<object>;  // typed result
}

export interface ToolSurface {
  tools: ToolDef[];
  instructions: string;          // canonical per-surface server instructions
  skills: Array<{ name: string; description: string; body: string }>;
}

export interface ResultPolicy {
  maxResultBytes?: number;       // rows budget per response; default ~25KB
  maxDescribeBytes?: number;     // describe budget; defaults to maxResultBytes
  /** Persist the full result, return a reference for truncated.full_result. */
  spill?: (full: RunResult, ctx: { toolName: string; args: unknown }) =>
    Promise<{ uri: string; note?: string } | undefined>;
}

export function exploreSurface(host: ExploreHost, opts?: { result?: ResultPolicy }): ToolSurface;
export function developSurface(host: DevelopHost, opts?: { result?: ResultPolicy }): ToolSurface;

/** Concatenate surfaces; dedupe identical shared tools (yo_help);
    accidental name collisions THROW at construction. */
export function mergeSurfaces(...surfaces: ToolSurface[]): ToolSurface;

/** Dumb serializer: typed result → MCP content + structuredContent. */
export function toContent(result: object): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
};

/** Canonical guidance blocks, exported standalone so custom layer-2 surfaces
    building custom tools inherit the same rules (§Guidance). */
export const guidance: { core: string; develop: string; explore: string };
```

### The tool sets (canonical names)

The explore surface is **source-centric**: the reference to a thing is a
`source` (+ optional `model_ref` to disambiguate when a bare source name is
ambiguous across the catalog).

| explore | develop |
|---|---|
| `list_sources` — only when `host.list` exists; lists exported sources + their annotations | `compile_file (path, expand?, emit_run_sql?)` — compile-and-inspect; IS describe here |
| `describe_source (source, model_ref?)` — the source + its join closure | `compile (source, base_path?)` — inline draft |
| `query (source, malloy, model_ref?, question?, givens?, execute?, max_rows?)` | `query` — `queryTool`, keyed by `model_ref` (= a model file path) |
| `yo_help (topic?)` *(shared)* | `prettify`, `yo_help` *(shared)* |

**One query core everywhere.** `queryTool(host, opts)` (model_ref-based, reused
by develop) and the explore source-centric `query` share `executeQuery()` — the
parse → validate-or-run → budget → field-not-found-nudge body — and differ only
in how they resolve the model and decorate the result (explore reports the
resolved `model_ref` and routes an executed run's SQL to the `host_only` channel
so the agent never sees SQL on `execute:true`). The surfaces differ by what
surrounds the query: develop adds compile-and-inspect over arbitrary project
paths (so its agent can write `.malloy` files); explore adds catalog +
source-describe over published refs. The old open toolset
(`run`/`run_file`/`list_runs`) is gone — query subsumes execution.

**`describe_source` resolves one source** (`model_ref` optional — a uniquely
named exported source resolves against the catalog; ambiguous → "pick one";
any named source resolves when `model_ref` is given, even unexported). It
returns three content blocks: a structured digest (the source + its deduped join
closure, two-channel annotations, `must_quote`), the requested source + closure
as **verbatim Malloy** (`malloy_text`, lifted into its own block so code is never
escaped in JSON), and a query cheatsheet. The envelope:

```ts
export interface SourceDescribeResult {
  ok: boolean;
  model_ref: string;                          // the model the source resolved in
  source: string;                             // the requested source
  sources?: Record<string, SourceInfo>;       // requested source + join closure, deduped
  malloy_text?: string;                       // verbatim Malloy, its own content block
  problems: Problem[];
}
```

(Givens are not on describe — a source's join tree is only potentially
activated, so it is never an authoritative given scope. Givens come from the
`query` `execute:false` loop, computed from the compiled query.)

**`query`** routes `execute:false` → `validateRestricted` (returns the
query's transitive `givens`, full detail — the authoritative "what must I
supply"), else `runRestricted` with budget + spill applied. Query text may
reference any source or named query the model defines (`run: top_carriers`,
refinable with `+ { … }`); the instructions teach this. `question` is in the
canonical schema as *optional* ("plain-English description of what this query
answers; hosts may record/share it"); a host may tighten it to required by
editing the descriptor.

**Result budgeting behavior:** drop whole rows from the end until under
budget (first-N respects the query's own ordering). Degenerate case — a
single row over budget → zero rows + SQL + `row_count` + a hint naming the
cause. No result cursors, ever: stateless hosts would have to persist the
result anyway, at which point the spill link is strictly better.

### Attaching to transports

```ts
// hosted /mcp (hand-rolled JSON-RPC, per request — construction is free)
const surface = exploreSurface(hostFor(user, db), { result: { spill: persistToLtool } });
const tools = surface.tools.map(t => ({
  ...t,
  description: `[${env.INSTANCE_NAME}] ${t.description}`,
  handler: withLogging(user, t.handler),   // slugs, toolCalls rows, ltool_url
}));
// tools/list → tools minus handler; tools/call → toContent(await tool.handler(args))

// fox CLI (stdio) — optional subpath adapter; SDK is an optional peer dep.
// develop and explore are SEPARATE server configurations (two windows), not
// a merged surface:
import { attachSurface } from '@malloyyo/mcp-engine/mcp-sdk';
const surface = opts.explore
  ? exploreSurface(localExploreHost)     // test window: index.malloy only
  : developSurface({ withRuntime });     // develop: any project path
const server = new McpServer(info, { instructions: surface.instructions });
attachSurface(server, surface, { registerSkillsAsPrompts: true });
```

Notes: surfaces never use MCP `isError` for compile/run failures (principle
6). The SDK adapter registers raw JSON Schema via the low-level API;
`instructions` must be passed at `McpServer` construction by the host (the
SDK offers no later injection).

## Guidance — the free service

"How to write Malloy over MCP" assistance is engine content: **one voice,
every host, every layer.** Different clients do not want different rules.

**Universal canon** (merged from both ancestors, owned here):
- Compiler is ground truth: iterate on `problems[]`; call `yo_help`
  before guessing syntax and after any non-obvious error (`help_topic` points
  the way).
- Develop surface: compile, don't read `.malloy` as text.
- Explore surface: reuse what the model defines — measures, dimensions,
  views, **named queries** — before writing your own.
- Do ranking / top-N / aggregation in Malloy, not client-side (now enforced
  by the result budget; the instruction explains the mechanism).
- Always show the user the Malloy that ran — even on failure — and timing on
  success.
- The restricted-query rules (also a `yo_help` topic, see §Content).

**Host policy** (appended/decorated, never in the engine): `question`
recording, share links, Query-summary format, instance routing tags,
notebook logging.

**Delivery channels**, all fed from the same canon: server instructions
(assembled per surface), tool descriptions, problem nudges, `yo_help`
topics, skills (as data; prompts/resources for SDK hosts), and the result
echo. The exported `guidance` blocks let custom layer-2 surfaces inherit
the canon without turnkey. Two channel rules learned in production
(malloyyo `src/lib/mcp-tools.ts` — the "lot of work in the query endpoint"):

- **Descriptions stay to one or two lines, each tool owning a distinct
  concept word** — long descriptions dilute the client's tool-search
  ranking. Behavioral policy lives in instructions, never in descriptions.
- **The result echo is the most reliable compliance channel** — clients
  re-read tool results right before responding. The engine uses it for
  truncation hints and recovery nudges; hosts use it for policy (malloyyo's
  Query-summary + share-link reminder rides on result decoration).

**Reachability rule:** every piece of guidance must be reachable through
`yo_help`, because it is the one channel every host has. (Today
`writing-malloy-with-mcp` ships only as an MCP prompt — invisible to the
hosted endpoint. Fixed by folding skill content into the topic index.)

## Package

- **`packages/mcp-engine`**, name **`@malloyyo/mcp-engine`**, `private: true`.
  Workspace-now / own-repo-later (Lloyd's `packages/cli` path); rename to
  `@malloydata/…` on extraction.
- **Exports:** `.` (types + helpers + turnkey) and `./mcp-sdk` (the
  `attachSurface` adapter).
- **`@malloydata/malloy` is a peerDependency — never bundled.** The
  architecture passes `Runtime` instances across the boundary and the error
  path does `instanceof MalloyError`; two copies of the package would make
  every compile error degrade to `internal-error`. The peer declaration makes
  the shared-instance requirement enforceable. `@modelcontextprotocol/sdk` is
  an *optional* peer (only `./mcp-sdk` touches it). No regular runtime deps.
- **Content is compiled into the bundle as strings** (esbuild
  `--loader:.md=text`). No runtime file reads → no Vercel
  `outputFileTracingIncludes` exposure, and the zero-fs claim is literal.
- **Build:** esbuild → ESM `dist/`, `tsc --emitDeclarationOnly`,
  `"type": "module"` — mirrors `packages/cli`.

## `yo_help` content plan

- Copy `malloy-cli/skills/malloy-language-reference.md` into
  `packages/mcp-engine/content/` with a provenance header (copied-from +
  date). Deliberate temporary fork, same posture as the code: parallel now,
  converge on extraction.
- Port `help.ts` parsing as-is: split on `##` headings → `{slug, title,
  body}`, preamble = `overview`, lookup slug → exact title → substring,
  parsed once at module init from the embedded string.
- Port the `ERROR_TOPIC_MAP` behind `helpTopicForCode`.
- Fold `writing-malloy-with-mcp.md` into the topic index (and keep it as a
  skill for prompt-capable hosts) — the reachability rule.
- **New topic: `restricted-queries`** — what restricted query text may and
  may not do; map `restricted-construct-forbidden` to it, so the recovery
  loop works for restriction errors the language reference doesn't cover.
- `log-analysis-to-notebook.md` is CLI-product behavior — stays a fox-CLI
  host skill, not engine content.

## What the MVP wires up

- **malloyyo server** (workstream #3): per-request `ExploreHost` over the
  existing pool (`withModel` = resolve dataset → lease pooled runtime →
  release), `spill` = persist + `ltool_url`, decoration = instance tag +
  logging + Query-summary policy. `/mcp` keeps its hand-rolled JSON-RPC and
  OAuth exactly as-is.
- **malloyyo CLI `malloyyo mcp`** (workstream #1, fox-mode) — **shipped**
  (`packages/cli/src/mcp.ts`): develop (default) and `--explore` as separate
  launch configurations; connections via `@malloydata/malloy-connections` +
  core's `discoverConfig` (start = ceiling = project root, so only the
  project's own config — the file publish ships — is seen; env overlays are
  the local-vs-server seam); runtime per call over the launch-time config,
  `shutdown('idle')` in finally; paths contained to the project root;
  explore resolves only `index.malloy`.
- **Publish path** (workstream #2 touchpoint): store named-query names
  alongside source names at introspection time so `ModelEntry.queries` hints
  are cheap.

## Implementation order — a ladder, not a cliff

The sections above are the complete target; do not build it at once. Each
slice ends runnable and felt.

**Slice 1 — the grounded develop loop** (the actual ambition: develop, test,
iterate on a real model with no GitHub anywhere):
- types; the **walker** (`compile` → `ModelInfo`); `run` (selection +
  problems); `prepareSource`; `developSurface`; the fox stdio server via
  `./mcp-sdk` — pointed at the **Open Payments** model.
- Deferred *within* slice 1 (types stay; logic stubbed): givens extraction
  (the demo model has none), describe budgeting (small model → always
  `full`), result budget + spill (small results), `stable_result`, `list`.

**Slice 2 — congruence, locally:** explore surface (`describe_model`
full+focus, `query` → `validateRestricted`/`runRestricted`) over a
directory-backed `ExploreHost`; `mergeSurfaces`; the fox's two windows
(develop + local explore — i.e. test mode) speaking to the same engine.

**Slice 3 — hosted + hardening:** the malloyyo `/mcp` host (pool-leasing
`withModel`, spill → ltool link, instance/logging decoration); real result
and describe budgets; `list`; the describe index path; givens completion;
`ModelEntry` hints at publish time.

**The long pole is the walker.** `compile()` → `ModelInfo` — explore/field
traversal, annotation routes, ref-vs-inline join resolution, query/run/given
extraction — is where the real time goes. malloy-cli's `compile.ts` is the
logic to port, but the reshaping (typed groups, sources keyed by name,
closure selection, projections) is genuine work, and everything downstream
trusts its output.

**Test strategy — golden files, walker first.** Fixture `.malloy` models →
assert the exact serialized `ModelInfo`, `SourceDescription` (closure), and
explore projection. Add cases for: anonymous/nested join inlining, the
`source_ref` invariant, restricted rejection
(`restricted-construct-forbidden` for each forbidden construct), run
selection errors (`selector-not-found` / `selector-out-of-range` /
`no-run`), and `problems[]` mapping with `help_topic` decoration. The walker
is the one piece worth covering *before* building on it.

## Decisions record (what a reviewer might overturn, and why it's this way)

1. **Model-first, not source-first** (reversal during design). The model is
   the compilation unit; source-first was malloyyo's `index.malloy` package
   convention leaking into the contract, and its `findBySource`
   newest-dataset-wins resolution already shadow-collides. Directory hosts
   (any file an export point) make a flat source list incoherent.
2. **Named queries are first-class explore content.** malloyyo exposed them
   only accidentally inside the raw `malloy_source` dump; killing the dump
   without making queries structural would have regressed curated models.
   No `list_queries` tool — queries ride in every describe at every detail
   level; a separate tool adds ranking surface without capability.
3. **Givens: model scope = declarations, query scope = requirements, source
   scope = nothing.** A source's join tree is only potentially activated, so
   per-source given sets would be guesses. `QueryValidationResult.givens`
   carries full `GivenInfo` so the compile answer is self-contained.
4. **One `query` tool with `execute:false`** (explore) vs. malloy-cli's
   split compile/run: matches what's deployed and proven against claude.ai
   tool-search ranking; congruence direction is hosted ← fox, not the
   reverse. Develop keeps the split (compile-heavy iteration, no ranking
   problem on stdio).
5. **Plain JSON Schema in the contract, no zod.** It's the wire format
   (hand-rolled host uses it verbatim) and avoids the SDK zod-version
   coupling. No runtime validator dep — handlers coerce defensively.
6. **`describe_source` is a parameter, not a tool.** Same walker; fewer
   tools; avoids two "describe" names diluting relevance ranking.
7. **snake_case wire keys uniformly** (`primary_key`, `row_count`,
   `has_default`) — the describe-shape doc's convention; deliberate
   divergence from malloy-cli's camelCase result fields.
8. **Anonymous join targets inline a `fields` group** — extension to the
   describe-shape doc forced by nested/repeated records (no name to ref).
   `expand:'inline'` retained for clients that can't cross-reference.
9. **Byte budget, not token estimates** — deterministic, no tokenizer dep;
   bytes/4 is proxy enough.
10. **`retry` hook instead of baked-in DuckDB lock retry** — lock policy is
    environment knowledge (co-running local DuckDB); hosted never wants it.
11. **`stable_result` opt-in on run helpers** — keeps malloyyo's web renderer
    working without bloating the MCP wire shape (turnkey never sets it).
12. **`Restricted` stays in the explore-verb names** — the security property
    visible at every call site.
13. **Field expressions come from the raw structDef `code`, not the API's
    `expression` getter** (implementation discovery): the getter echoes the
    field name, so malloy-cli's "emit when it differs from the name" check
    never fired — its output silently lacked expressions. The engine reads
    `structDef.fields[].code`, so `total_distance` carries
    `expression: "distance.sum()"` as the describe-shape intends.
14. **All explores in the compiled namespace are described, not just
    entry-file-local ones** (divergence from malloy-cli, forced by packages):
    a package whose `index.malloy` imports its sources would otherwise
    describe as empty. Locality is still encoded — `location` is only
    emitted for locally-defined items.
15. **Surfaces renamed `author`/`consumer` → `develop`/`explore`**
    (vocabulary change, 2026-06-12) across the doc, the API
    (`developSurface`/`exploreSurface`, `DevelopHost`/`ExploreHost`,
    `Surface = 'develop' | 'explore'`, `guidance.develop/.explore`), file
    names, and golden names. Wire tool names were never surface-named, so
    nothing changes on the wire. "Author" survives only where it means the
    human who wrote the model.
16. **Lean tool descriptions** (2026-06-12): canonical descriptions trimmed
    to one-two lines per the deployed ranking lesson (§Guidance); the
    behavioral prose they carried was already duplicated in the surface
    instructions.
17. **`CompileResult.formatted` instead of returning prettified text**
    (2026-06-12): compile echoing canonical source would roughly double
    every compile's token cost; a boolean ("prettify would change this")
    costs one token and the agent calls `prettify` only when it wants the
    text. Omitted when unjudgeable (no readSource / parse errors), which
    makes it naturally develop-only.
18. **Develop tools speak pathnames, not URIs** (2026-06-12): the
    agent-facing `path` / `base_path` parameters are filesystem paths
    relative to the server root (absolute paths and file:// URIs are
    tolerated). URLs are malloy's internal representation; `prepareSource`
    does the conversion host-side. An agent editing files thinks in the
    same paths its file tools use.

19. **Develop surface recomposed onto the query tool** (2026-06-12, per
    brain `mcp-fox-mode/develop-server.md`): develop =
    compile_file/compile/query/prettify/yo_help. `queryTool` factored
    out with an `InspectHint` so each surface's field-not-found nudge points
    at its own inspect tool. The old open set survives as helpers only.

## Non-goals / deferred

- **Cancellation/abort** — Malloy execution doesn't support it cleanly;
  timeouts are host/lifecycle concerns. Explicit non-goal, not an oversight.
- **Result cursors / pagination** — see budgeting; spill link is strictly
  better for stateless hosts.
- **Query output schemas** in describe (`emit_query_schemas`) — useful but
  forces per-query prepared-result compiles; opt-in later if wanted, same
  pattern as `emit_run_sql`.
- **Bindings** — entirely upstream of the injection boundary; the library
  never sees one (the host picks the reader it builds the Runtime from).
- **AuthN/Z, multi-tenancy policy** — host turf, per the MVP's
  mechanism-not-policy line.
