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
import { selectSource } from '../select';
import { projectDescription } from '../project';
import { runRestricted, validateRestricted } from '../restricted';
import { applyResultBudget } from './budget';
import { DEFAULT_ROW_LIMIT } from '../run';
import { assembleInstructions } from '../guidance';
import { prompts } from '../prompts';
import { codeProblem } from '../problems';
import type {
  ModelEntry,
  ModelList,
  Problem,
  SourceDescribeResult,
  SourceDescription,
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
      help_topic: p.help_topic ?? 'fields',
    };
  };
}

export interface QueryToolOptions {
  result?: ResultPolicy;
  /** Default: { tool: 'describe_source', param: 'model_ref', also: 'source' }. */
  inspect?: InspectHint;
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
      const malloy = argString(args, 'malloy');
      const execute = argOptBool(args, 'execute') ?? true;
      const givens = argRecord(args, 'givens');
      const maxRows = argOptNumber(args, 'max_rows');
      const rowLimit = Math.max(1, Math.min(10_000, maxRows ?? DEFAULT_ROW_LIMIT));
      try {
        return await host.withModel(ref, async (m) => {
          const fix = refNudge(ref, inspect);
          if (!execute) {
            const v = await validateRestricted(m.runtime, m.entry, malloy);
            return { ...v, problems: v.problems.map(fix) };
          }
          const full = await runRestricted(m.runtime, m.entry, malloy, { rowLimit, givens: givens as never });
          const budgeted = await applyResultBudget(full, opts.result, { toolName: 'query', args });
          return { ...budgeted, problems: budgeted.problems.map(fix) };
        });
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
      help_topic: p.help_topic ?? 'fields',
    };
  };
}

/** Block 2 of describe_source: requested source + closure as verbatim Malloy,
    sliced from each definition's body (prepend the `source:` keyword the slice
    omits). Sources whose body could not be re-read are skipped. */
function renderSourcesMalloy(sel: SourceDescription): string {
  return Object.values(sel.sources)
    .filter((s) => s.body)
    .map((s) => `source: ${s.body}`)
    .join('\n\n');
}

// ── tools (explore experience) ────────────────────────────────────────

function listSourcesTool(host: ExploreHost): ToolDef {
  return {
    name: 'list_sources',
    title: prompts.explore.tools.list_sources.title,
    description: prompts.explore.tools.list_sources.description,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const { entries } = await host.list!();
      const models = entries.map((e) => {
        const m: Record<string, unknown> = { model_ref: e.model_ref };
        if (e.description) m.description = e.description;
        if (e.instructions) m.instructions = e.instructions;
        if (e.sources?.length) {
          m.sources = e.sources.map((s) => {
            const o: Record<string, unknown> = { source_ref: s.source_ref };
            if (s.description) o.description = s.description;
            if (s.instructions) o.instructions = s.instructions;
            if (s.mustQuote) o.mustQuote = true;
            return o;
          });
        }
        return m;
      });
      return { ok: true, models };
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
          const sel = selectSource(compiled.model, source);
          if (!sel) {
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
          const malloy_text = renderSourcesMalloy(sel);
          const projected = projectDescription(sel, 'explore');
          const base: SourceDescribeResult = {
            ok: true, model_ref: modelRef, source,
            sources: projected.sources, problems: compiled.problems,
          };
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
      const malloy = argString(args, 'malloy');
      const modelRefArg = argOptString(args, 'model_ref');
      const execute = argOptBool(args, 'execute') ?? true;
      const givens = argRecord(args, 'givens');
      const maxRows = argOptNumber(args, 'max_rows');
      const rowLimit = Math.max(1, Math.min(10_000, maxRows ?? DEFAULT_ROW_LIMIT));
      const r = await resolveModel(host, source, modelRefArg);
      if ('problem' in r) return { ok: false, problems: [r.problem] };
      const modelRef = r.model_ref;
      try {
        return await host.withModel(modelRef, async (m) => {
          const fix = srcNudge(modelRef, source);
          // The model the source resolved to. Reported so the agent (and a host
          // recording/sharing the call) knows which model answered, without
          // re-running the source→model resolution the surface just did.
          if (!execute) {
            const v = await validateRestricted(m.runtime, m.entry, malloy);
            return { ...v, model_ref: modelRef, problems: v.problems.map(fix) };
          }
          const full = await runRestricted(m.runtime, m.entry, malloy, { rowLimit, givens: givens as never });
          const budgeted = await applyResultBudget(full, opts.result, { toolName: 'query', args });
          // Explore: SQL is output, not input — it rides execute:false, never the run.
          delete (budgeted as { sql?: string }).sql;
          return { ...budgeted, model_ref: modelRef, problems: budgeted.problems.map(fix) };
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
