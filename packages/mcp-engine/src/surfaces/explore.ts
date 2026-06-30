// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The explore surface — main's source-centric interactions, rebuilt on the
// engine primitives. The reference to a thing is the engine's model→source
// path: (model_ref, source). `list_sources` dumps the catalog hierarchy so the
// agent has both halves; `describe_source`/`query` take `source` (+ optional
// `model_ref`), resolving a bare source against the catalog when it is unique.
//
// Tool titles/descriptions are prose in content/prompts/**.md, read via
// `prompts` (never inlined). Behavioural policy lives in the surface
// instructions. Construction is zero-I/O; the host supplies the ExploreHost.

import type { Runtime } from '@malloydata/malloy';
import { compile } from '../walker';
import { buildSourceDescribe } from '../project';
import { runRestricted, validateRestricted } from '../restricted';
import { applyResultBudget } from './budget';
import { DEFAULT_ROW_LIMIT } from '../run';
import { assembleInstructions } from '../guidance';
import { prompts } from '../prompts';
import { codeProblem } from '../problems';
import { HOST_ONLY } from '../types';
import type {
  CompactField,
  ExploreDescribedSource,
  ListedModel,
  ListedSource,
  ListSourcesResult,
  ModelEntry,
  ModelList,
  Problem,
  QueryValidationResult,
  RunResult,
  SourceDescribeResult,
  SourceInfo,
  WithHostOnly,
} from '../types';
import {
  argOptBool,
  argOptNumber,
  argOptString,
  argRecord,
  argString,
  sharedSkills,
  withHelp,
  yoHelpTool,
  type ResultPolicy,
  type ToolDef,
  type ToolSurface,
} from './shared';

export interface BoundModel {
  runtime: Runtime;
  entry: URL;
  readSource?: (href: string) => string | undefined;
}

export interface ExploreHost {
  /**
   * Bind a model by ref (a published model name) and lease it for fn. Must be
   * O(one lookup) — never enumerate to resolve. Throw to refuse; throw the SAME
   * message for "does not exist" and "not visible to this principal" so a probe
   * cannot tell them apart.
   */
  withModel<T>(ref: string, fn: (m: BoundModel) => Promise<T>): Promise<T>;
  /**
   * The catalog: every model visible to this principal, with its EXPORTED
   * source + named-query names. Dumped by `list_sources` and used to resolve a
   * bare source. Absent → no `list_sources`, and `model_ref` is required.
   */
  list?(): Promise<ModelList>;
}

export interface ExploreSurfaceOptions {
  result?: ResultPolicy;
}

// ── the shared (develop-reused) query tool — model_ref based ──────────
// Kept for the develop surface, which reuses it pointed at a model file path.
// The explore surface uses its own source-centric query (below).

/** Which tool a field-not-found nudge points at, and the params to mention. */
export interface InspectHint {
  tool: string;
  param: string;
  also?: string;
}

function refModelProblem(ref: string, e: unknown): Problem {
  const msg = e instanceof Error ? e.message : String(e);
  return codeProblem('model-not-found', `Cannot use model '${ref}': ${msg}`);
}

function refNudge(ref: string, inspect: InspectHint): (p: Problem) => Problem {
  const also = inspect.also ? ` and ${inspect.also}=<the source you queried>` : '';
  return (p) => {
    if (p.code !== 'field-not-found') return p;
    return {
      ...p,
      message:
        `${p.message} — call ${inspect.tool} with ${inspect.param}="${ref}"${also} ` +
        'to see what fields, measures, views, and joins exist.',
      help_topic: p.help_topic ?? 'language/fields',
    };
  };
}

export interface QueryToolOptions {
  result?: ResultPolicy;
  /** Default: { tool: 'describe_source', param: 'model_ref', also: 'source' }. */
  inspect?: InspectHint;
}

/** The query core both query tools share once they've leased a model and built
    their field-not-found nudge: parse the query args, then either validate
    (execute:false → SQL + the givens the query references) or run (execute:true
    → budgeted rows). Model resolution and result decoration differ per surface
    and stay in the callers. */
async function executeQuery(
  m: BoundModel,
  args: Record<string, unknown>,
  fix: (p: Problem) => Problem,
  result?: ResultPolicy,
): Promise<RunResult | QueryValidationResult> {
  const malloy = argString(args, 'malloy');
  const execute = argOptBool(args, 'execute') ?? true;
  const givens = argRecord(args, 'givens');
  const rowLimit = Math.max(1, Math.min(10_000, argOptNumber(args, 'max_rows') ?? DEFAULT_ROW_LIMIT));
  if (!execute) {
    const v = await validateRestricted(m.runtime, m.entry, malloy);
    return { ...v, problems: v.problems.map(fix) };
  }
  const full = await runRestricted(m.runtime, m.entry, malloy, { rowLimit, givens });
  const budgeted = await applyResultBudget(full, result, { toolName: 'query', args });
  return { ...budgeted, problems: budgeted.problems.map(fix) };
}

/** Model_ref-based query tool — one definition the develop surface reuses
    (pointed at a model file path). The explore surface does NOT use this; it
    has its own source-centric query. */
export function queryTool(
  host: Pick<ExploreHost, 'withModel'>,
  opts: QueryToolOptions = {},
): ToolDef {
  const inspect = opts.inspect ?? { tool: 'describe_source', param: 'model_ref', also: 'source' };
  return {
    name: 'query',
    title: prompts.shared.tools.query.title,
    description: prompts.shared.tools.query.description,
    inputSchema: {
      type: 'object',
      properties: {
        model_ref: {
          type: 'string',
          description:
            'Model ref — a published model name, or (on a local develop ' +
            'server) the path of the root model file.',
        },
        malloy: { type: 'string', description: 'Malloy query text, e.g. `run: orders -> { ... }`.' },
        question: {
          type: 'string',
          description: 'Plain-English description of what this query answers; hosts may record or share it.',
        },
        givens: {
          type: 'object',
          description: 'Values for $NAME givens, keyed by name (no $). Validate with execute:false to learn which givens the query needs.',
        },
        execute: { type: 'boolean', description: 'Default true. false → compile/validate only (no execution).' },
        max_rows: { type: 'integer', minimum: 1, maximum: 10000, description: `Row cap (default ${DEFAULT_ROW_LIMIT}).` },
      },
      required: ['model_ref', 'malloy'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const ref = argString(args, 'model_ref');
      if (!ref.trim()) {
        return { ok: false, problems: [codeProblem('model-ref-required', prompts.shared.errors['no-model-ref'])] };
      }
      try {
        return await host.withModel(ref, (m) =>
          executeQuery(m, args, refNudge(ref, inspect), opts.result),
        );
      } catch (e) {
        return { ok: false, problems: [refModelProblem(ref, e)] };
      }
    },
  };
}

// ── source → model resolution (explore experience) ───────────────────
// The reference is (model_ref, source). model_ref given → trust it (withModel
// refuses if wrong). Omitted → resolve against the catalog: a uniquely-named
// EXPORTED source resolves; ambiguous → "pick one"; unknown to the catalog →
// not-found (a NON-exported source is reachable only by passing model_ref).

type Resolved = { model_ref: string } | { problem: Problem };

async function resolveModel(
  host: ExploreHost,
  source: string,
  modelRef: string | undefined,
): Promise<Resolved> {
  if (modelRef) return { model_ref: modelRef };
  if (!host.list) {
    return {
      problem: codeProblem(
        'model-ref-required',
        'Pass model_ref + source. Use list_sources to see which model a source lives in.',
      ),
    };
  }
  const entries: ModelEntry[] = (await host.list()).entries;
  const hits = entries.filter((e) => e.sources?.some((s) => s.source_ref === source));
  if (hits.length === 1) return { model_ref: hits[0]!.model_ref };
  if (hits.length === 0) {
    return {
      problem: codeProblem(
        'source-not-found',
        `No exported source named '${source}' in any model you can see. ` +
          'Call list_sources, or pass model_ref if it is an internal source.',
      ),
    };
  }
  return {
    problem: codeProblem(
      'source-ambiguous',
      `Source '${source}' exists in more than one model: ` +
        `${hits.map((h) => h.model_ref).join(', ')}. Pass model_ref to pick one.`,
    ),
  };
}

/** Field-not-found recovery for the source-centric surface: point at
    describe_source for this exact (model_ref, source). */
function srcNudge(modelRef: string, source: string): (p: Problem) => Problem {
  return (p) => {
    if (p.code !== 'field-not-found') return p;
    return {
      ...p,
      message:
        `${p.message} — call describe_source with source="${source}"` +
        (modelRef ? ` model_ref="${modelRef}"` : '') +
        ' to see what fields, measures, views, and joins exist.',
      help_topic: p.help_topic ?? 'language/fields',
    };
  };
}

/** describe_source's Malloy block: JUST the described source's verbatim
    declaration (sliced from its body; prepend the `source:` keyword the slice
    omits). Joined sources are recovered by describe_source-ing them by name —
    they are not dumped here. Empty when the body could not be re-read. */
function sourceAsMalloy(s: SourceInfo | undefined): string {
  return s?.body ? `source: ${s.body}` : '';
}

/** Synthesize a couple of runnable, copy-paste-correct example queries from the
    source's REAL declared fields. The point is to model REUSE — a model should
    invoke a published view and aggregate a published measure (`total_babies`)
    rather than re-deriving it (`num_births.sum()`). Built only from names the
    schema actually exposes, so each example compiles. Empty when there is
    nothing aggregable to build from. */
function buildQueryExamples(ds: ExploreDescribedSource): string[] {
  const ref = (name: string, mustQuote?: boolean): string =>
    mustQuote ? `\`${name}\`` : name;
  const out: string[] = [];

  // A published view is the strongest seed: one token, guaranteed valid.
  const view = Object.keys(ds.views)[0];
  if (view) out.push(`run: ${ds.name} -> ${view}`);

  // The workhorse, using a DECLARED measure + a scalar dimension (prefer a
  // string column to group by; fall back to any scalar).
  const dims = Object.entries(ds.dimensions).filter(([, m]) => 'type' in m) as [
    string,
    CompactField,
  ][];
  const dim = dims.find(([, m]) => m.type === 'string') ?? dims[0];
  const measure = Object.entries(ds.measures)[0];
  if (dim && measure) {
    const [dName, dField] = dim;
    const [mName, mField] = measure;
    const m = ref(mName, mField.must_quote);
    out.push(
      `run: ${ds.name} -> {\n` +
        `  group_by: ${ref(dName, dField.must_quote)}\n` +
        `  aggregate: ${m}\n` +
        `  order_by: ${m} desc\n` +
        `  limit: 10\n` +
        `}`,
    );
  }
  return out;
}

// ── tools (explore experience) ────────────────────────────────────────

function listSourcesTool(host: ExploreHost): ToolDef {
  return {
    name: 'list_sources',
    title: prompts.explore.tools.list_sources.title,
    description: prompts.explore.tools.list_sources.description,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (): Promise<ListSourcesResult> => {
      const { entries } = await host.list!();
      // models keyed by model_ref, each model's sources keyed by source_ref;
      // the ref is the key, not a field. Null-prototype maps so a reserved ref
      // (`constructor`, `__proto__`, …) is an ordinary data key. Insertion
      // order follows `entries`.
      const models: Record<string, ListedModel> = Object.create(null);
      for (const e of entries) {
        const m: ListedModel = {};
        if (e.description) m.description = e.description;
        if (e.instructions) m.instructions = e.instructions;
        if (e.sources?.length) {
          const sources: Record<string, ListedSource> = Object.create(null);
          for (const s of e.sources) {
            const o: ListedSource = {};
            if (s.description) o.description = s.description;
            if (s.instructions) o.instructions = s.instructions;
            if (s.must_quote) o.must_quote = true;
            sources[s.source_ref] = o;
          }
          m.sources = sources;
        }
        models[e.model_ref] = m;
      }
      return { ok: true, guidance: prompts.explore.guidance, models };
    },
  };
}

function describeSourceTool(host: ExploreHost): ToolDef {
  return {
    name: 'describe_source',
    title: prompts.explore.tools.describe_source.title,
    description: prompts.explore.tools.describe_source.description,
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'The source to describe (a source the model publishes).' },
        model_ref: {
          type: 'string',
          description:
            'The model the source lives in (the model_ref from list_sources). ' +
            'Optional when the source name is unique across the catalog.',
        },
      },
      required: ['source'],
      additionalProperties: false,
    },
    handler: async (args): Promise<SourceDescribeResult> => {
      const source = argString(args, 'source');
      const modelRefArg = argOptString(args, 'model_ref');
      if (!source.trim()) {
        return {
          ok: false, model_ref: modelRefArg ?? '', source,
          problems: [codeProblem('source-required', 'A source name is required. Use list_sources to see them.')],
        };
      }
      const r = await resolveModel(host, source, modelRefArg);
      if ('problem' in r) {
        return { ok: false, model_ref: modelRefArg ?? '', source, problems: [r.problem] };
      }
      const modelRef = r.model_ref;
      try {
        return await host.withModel(modelRef, async (m) => {
          // No exportedOnly: describe resolves ANY named source (the back door).
          const compiled = await compile(m.runtime, m.entry, { readSource: m.readSource });
          if (!compiled.ok || !compiled.model) {
            return { ok: false, model_ref: modelRef, source, problems: compiled.problems };
          }
          const built = buildSourceDescribe(compiled.model, source);
          if (!built) {
            const available = Object.keys(compiled.model.sources);
            return {
              ok: false, model_ref: modelRef, source,
              problems: [
                ...compiled.problems,
                codeProblem(
                  'source-not-found',
                  `No source named '${source}' in '${modelRef}'. Sources: ${available.join(', ') || '(none)'}.`,
                ),
              ],
            };
          }
          // malloy_text is JUST the described source's own declaration; joined
          // sources are recovered via describe_source by name.
          const malloy_text = sourceAsMalloy(compiled.model.sources[source]);
          const base: SourceDescribeResult = {
            ok: true, model_ref: modelRef, source,
            guidance: prompts.explore.guidance,
            described_source: built.described_source,
            problems: compiled.problems,
          };
          const examples = buildQueryExamples(built.described_source);
          if (examples.length) base.examples = examples;
          if (Object.keys(built.joins).length) base.joins = built.joins;
          if (Object.keys(built.join_source_map).length) base.join_source_map = built.join_source_map;
          return malloy_text ? { ...base, malloy_text } : base;
        });
      } catch (e) {
        return { ok: false, model_ref: modelRef, source, problems: [refModelProblem(modelRef, e)] };
      }
    },
  };
}

function exploreQueryTool(host: ExploreHost, opts: ExploreSurfaceOptions): ToolDef {
  return {
    name: 'query',
    title: prompts.shared.tools.query.title,
    description: prompts.shared.tools.query.description,
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'The source the query runs against.' },
        malloy: { type: 'string', description: 'Malloy query text, e.g. `run: orders -> { ... }`.' },
        model_ref: {
          type: 'string',
          description: 'The model the source lives in (optional when the source name is unique).',
        },
        question: {
          type: 'string',
          description: 'Plain-English description of what this query answers; hosts may record or share it.',
        },
        givens: {
          type: 'object',
          description: 'Values for $NAME givens, keyed by name (no $). Discover which a query needs with execute:false.',
        },
        execute: {
          type: 'boolean',
          description: 'Default true. false → compile/validate only (returns SQL + the givens the query references).',
        },
        max_rows: { type: 'integer', minimum: 1, maximum: 10000, description: `Row cap (default ${DEFAULT_ROW_LIMIT}).` },
      },
      required: ['source', 'malloy'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const source = argString(args, 'source');
      const modelRefArg = argOptString(args, 'model_ref');
      const execute = argOptBool(args, 'execute') ?? true;
      const r = await resolveModel(host, source, modelRefArg);
      if ('problem' in r) return { ok: false, problems: [r.problem] };
      const modelRef = r.model_ref;
      // Write-side guard (query only): when an explicit model_ref is passed and
      // the catalog shows that model EXISTS but doesn't export this source — while
      // some OTHER model does — refuse, so a query never resolves a source through
      // the wrong model (and never records a wrong (source, model) pair). Skips
      // when the model isn't in the catalog, so a bogus model_ref fails in
      // withModel (model-not-found) rather than leaking which model_refs exist.
      if (modelRefArg && host.list) {
        const entries = (await host.list()).entries;
        const here = entries.find((e) => e.model_ref === modelRef);
        const inModel = here?.sources?.some((s) => s.source_ref === source) ?? false;
        const elsewhere = entries
          .filter((e) => e.model_ref !== modelRef && e.sources?.some((s) => s.source_ref === source))
          .map((e) => e.model_ref);
        if (here && !inModel && elsewhere.length > 0) {
          return {
            ok: false,
            problems: [
              codeProblem(
                'source-not-in-model',
                `Model '${modelRef}' has no source '${source}' — it's in: ${elsewhere.join(', ')}. ` +
                  'Pass that model_ref, or fix the source name.',
              ),
            ],
          };
        }
      }
      try {
        return await host.withModel(modelRef, async (m) => {
          const res = await executeQuery(m, args, srcNudge(modelRef, source), opts.result);
          // execute:false: SQL is the confirmatory-inspect channel — the agent
          // SHOULD see it; just tag which model the source resolved to.
          if (!execute) return { ...res, model_ref: modelRef };
          // execute:true: withhold SQL from the agent (SQL rides execute:false),
          // but the run generated it — park it on the host_only channel toContent
          // drops, so a host can record it. Plus the resolved model_ref, so the
          // host needn't re-run resolution. Typed end-to-end via WithHostOnly.
          const { sql, ...rest } = res as RunResult;
          const out: WithHostOnly<RunResult & { model_ref: string }> = { ...rest, model_ref: modelRef };
          if (sql !== undefined) out[HOST_ONLY] = { sql };
          return out;
        });
      } catch (e) {
        return { ok: false, problems: [refModelProblem(modelRef, e)] };
      }
    },
  };
}

export function exploreSurface(
  host: ExploreHost,
  opts: ExploreSurfaceOptions = {},
): ToolSurface {
  const tools: ToolDef[] = [];
  if (host.list) tools.push(listSourcesTool(host));
  tools.push(describeSourceTool(host));
  tools.push(exploreQueryTool(host, opts));
  tools.push(yoHelpTool());
  return {
    tools: tools.map(withHelp),
    instructions: assembleInstructions('explore'),
    skills: sharedSkills(),
  };
}
