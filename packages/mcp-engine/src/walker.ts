// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The walker: compile a model via an injected Runtime and reshape malloy's
// Model API into the wire ModelInfo. Logic ported from malloy-cli
// src/mcp/compile.ts, reshaped per docs/mcp-engine.md: typed field groups,
// sources keyed by name, description promotion, snake_case wire keys.
//
// One deliberate divergence from malloy-cli: ALL explores in the compiled
// model's namespace are described (imports included), not just those local
// to the entry file. An explore-surface query against a package whose index.malloy
// imports its sources needs the full namespace; locality is still encoded —
// `location` is only emitted for locally-defined items.

import type {
  Annotations,
  AtomicField,
  Explore,
  ExploreField,
  Field,
  Model,
  QueryField,
  Runtime,
} from '@malloydata/malloy';
import {
  MalloyError,
  expressionIsAggregate,
  expressionIsAnalytic,
} from '@malloydata/malloy';
import { errorProblem, mapProblems } from './problems';
import { prettify } from './prettify';
import { needsQuote } from './quoting';
import type {
  Annotation,
  CompileResult,
  FieldGroups,
  FieldInfo,
  GivenInfo,
  JoinInfo,
  Loc,
  ModelInfo,
  NamedQueryInfo,
  RunStatementInfo,
  SourceInfo,
  ViewInfo,
} from './types';

export interface CompileOptions {
  /** Re-read source text by href, for body slicing. Absent → bodies omitted
      (explore-bound describes should omit it — projection strips bodies). */
  readSource?: (href: string) => string | undefined;
  /** Join rendering: 'ref' (default) emits source_ref; 'inline' recursively
      inlines for clients that cannot cross-reference. */
  expand?: 'ref' | 'inline';
  /** Compile run: statements to SQL (large; default false). */
  emitRunSql?: boolean;
  /**
   * Enumerate only the model's EXPORTED sources as top-level (the public
   * surface), not the full namespace. The explore surface sets this so a
   * consumer sees only what the model author exported; imports and unexported
   * intermediates stay private. Joins from an exported source to a private one
   * inline (the private target is not in knownSources, so it cannot be
   * referenced). Develop leaves it off — the author sees everything.
   */
  exportedOnly?: boolean;
}

const MAX_JOIN_DEPTH = 4;

type MalloyLocation = {
  url: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
};

function toLoc(loc?: MalloyLocation): Loc | undefined {
  if (!loc) return undefined;
  return [loc.range.start.line, loc.range.start.character];
}

function annotationList(a: Annotations | undefined): Annotation[] {
  if (!a) return [];
  return a.forRoute().map((n) => ({ route: n.route, text: n.content }));
}

/** Promote the doc-comment route (`#" …`) to the description field — every
    `#"` doc line, in source order, joined (not just the first). Other routes
    (render tags `#`, etc.) are NOT description and stay out. */
function descriptionOf(annotations: Annotation[]): string | null {
  const docs = annotations
    .filter((a) => a.route === '"')
    .map((a) => a.text.trim())
    .filter(Boolean);
  return docs.length ? docs.join('\n') : null;
}

function isLocal(loc: { url: string } | undefined, rootUri: string): boolean {
  return !!loc && loc.url === rootUri;
}

/** Slice [start..end) from source text using a Malloy DocumentLocation. */
function sliceSource(
  src: string | undefined,
  loc: MalloyLocation | undefined,
): string | undefined {
  if (!src || !loc) return undefined;
  const lines = src.split('\n');
  const { start, end } = loc.range;
  if (start.line < 0 || start.line >= lines.length) return undefined;
  if (end.line < 0 || end.line >= lines.length) return undefined;
  if (start.line === end.line) {
    return lines[start.line]?.slice(start.character, end.character);
  }
  const out: string[] = [lines[start.line]?.slice(start.character) ?? ''];
  for (let i = start.line + 1; i < end.line; i++) out.push(lines[i] ?? '');
  out.push(lines[end.line]?.slice(0, end.character) ?? '');
  return out.join('\n');
}

function joinRel(ef: ExploreField): 'one' | 'many' | 'cross' {
  const j = (ef.structDef as { join?: string }).join;
  if (j === 'one' || j === 'many' || j === 'cross') return j;
  return 'one';
}

function isScalarArray(parent: ExploreField): boolean {
  const sd = parent.structDef as { type?: string; elementTypeDef?: { type?: string } };
  return sd.type === 'array' && sd.elementTypeDef?.type !== 'record_element';
}

function isRepeatedRecord(parent: ExploreField): boolean {
  const sd = parent.structDef as { type?: string; elementTypeDef?: { type?: string } };
  return sd.type === 'array' && sd.elementTypeDef?.type === 'record_element';
}

function isAnonymousRecord(parent: ExploreField): boolean {
  return (parent.structDef as { type?: string }).type === 'record';
}

/** Scalar arrays surface a synthetic `value` column — strip it. */
function stripScalarArrayValue(parent: ExploreField, groups: FieldGroups): FieldGroups {
  if (!isScalarArray(parent)) return groups;
  return { ...groups, dimensions: groups.dimensions.filter((f) => f.name !== 'value') };
}

type StructDefField = { name: string; expressionType?: string; code?: string };

function fieldKind(
  af: AtomicField,
  structDefFields: StructDefField[],
): 'measure' | 'dimension' {
  const raw = structDefFields.find((x) => x.name === af.name);
  const et = raw?.expressionType;
  if (et && (expressionIsAggregate(et as never) || expressionIsAnalytic(et as never))) {
    return 'measure';
  }
  return 'dimension';
}

function resolveSourceRef(
  ef: ExploreField,
  knownSources: Set<string>,
): string | undefined {
  if (isScalarArray(ef) || isRepeatedRecord(ef) || isAnonymousRecord(ef)) {
    return undefined;
  }
  const sd = ef.structDef as { name?: string; sourceID?: string };
  if (sd.sourceID) {
    const origName = sd.sourceID.split('@')[0];
    if (origName && knownSources.has(origName)) return origName;
  }
  if (sd.name && knownSources.has(sd.name)) return sd.name;
  if (knownSources.has(ef.name)) return ef.name;
  return undefined;
}

interface WalkContext {
  rootUri: string;
  knownSources: Set<string>;
  opts: CompileOptions;
  readSource: (urlHref: string) => string | undefined;
}

function emptyGroups(): FieldGroups {
  return { dimensions: [], measures: [], views: [], joins: [] };
}

function walkFields(
  fields: Field[],
  structDefFields: StructDefField[],
  depth: number,
  ctx: WalkContext,
): FieldGroups {
  const groups = emptyGroups();
  for (const f of fields) {
    const annotations = annotationList(f.annotations);
    const description = descriptionOf(annotations);
    const mLoc = f.location as MalloyLocation | undefined;
    const local = isLocal(mLoc, ctx.rootUri);
    const loc = local ? toLoc(mLoc) : undefined;

    if (f.isExploreField()) {
      const ef = f as ExploreField;
      const ref = resolveSourceRef(ef, ctx.knownSources);
      const join: JoinInfo = {
        name: f.name,
        relationship: joinRel(ef),
        description,
      };
      if (ref) join.source_ref = ref;
      if (needsQuote(f.name)) join.mustQuote = true;
      if (annotations.length > 0) join.annotations = annotations;
      if (loc) join.location = loc;
      // Slice the join's declaration (`name is target on/with …` — carries the
      // keys). Synthetic nested-record/array joins have no own declaration;
      // their location points at the parent source, so skip them.
      const synthetic =
        isScalarArray(ef) || isRepeatedRecord(ef) || isAnonymousRecord(ef);
      if (!synthetic && mLoc) {
        const body = sliceSource(ctx.readSource(mLoc.url), mLoc);
        if (body) join.body = body;
      }

      const shouldInline = ctx.opts.expand === 'inline' || !ref;
      if (shouldInline && depth < MAX_JOIN_DEPTH) {
        const childStructFields =
          (ef.structDef.fields as StructDefField[]) ?? [];
        const sub = walkFields(ef.allFields, childStructFields, depth + 1, ctx);
        join.fields = stripScalarArrayValue(ef, sub);
      }
      groups.joins.push(join);
      continue;
    }

    if (f.isQueryField()) {
      const qf = f as QueryField;
      const view: ViewInfo = { name: f.name, description };
      if (needsQuote(f.name)) view.mustQuote = true;
      if (annotations.length > 0) view.annotations = annotations;
      if (loc) view.location = loc;
      // Body follows the definition's OWN location — across imports too (the
      // reader cache holds every file the compile read). `location` (the coord)
      // stays develop-only/local; the source text rides on explore.
      if (mLoc) {
        const body = sliceSource(ctx.readSource(mLoc.url), mLoc);
        if (body) view.body = body;
      }
      // QueryField expression is usually the view name itself — drop it.
      void qf;
      groups.views.push(view);
      continue;
    }

    const af = f as AtomicField;
    const info: FieldInfo = { name: f.name, type: af.type, description };
    if (needsQuote(f.name)) info.mustQuote = true;
    // The API's `expression` getter echoes the field name; the defining
    // source expression lives on the raw structDef field as `code`.
    const raw = structDefFields.find((x) => x.name === f.name);
    const expr = raw?.code?.trim() || undefined;
    if (expr && expr !== f.name) info.expression = expr;
    if (annotations.length > 0) info.annotations = annotations;
    if (loc) info.location = loc;
    if (fieldKind(af, structDefFields) === 'measure') groups.measures.push(info);
    else groups.dimensions.push(info);
  }
  return groups;
}

function walkExplore(e: Explore, ctx: WalkContext): SourceInfo {
  const structDefFields = (e.structDef.fields as StructDefField[]) ?? [];
  const groups = walkFields(e.allFields, structDefFields, 0, ctx);
  const annotations = annotationList(e.annotations);
  const out: SourceInfo = {
    name: e.name,
    description: descriptionOf(annotations),
    primary_key: e.primaryKey ?? null,
    ...groups,
  };
  if (needsQuote(e.name)) out.mustQuote = true;
  if (annotations.length > 0) out.annotations = annotations;
  const mLoc = e.location as MalloyLocation | undefined;
  if (isLocal(mLoc, ctx.rootUri)) {
    const loc = toLoc(mLoc);
    if (loc) out.location = loc;
  }
  // The source's verbatim declaration text (across imports too); location stays
  // local. The explore surface ships this as a clean Malloy block, not in JSON.
  if (mLoc) {
    const body = sliceSource(ctx.readSource(mLoc.url), mLoc);
    if (body) out.body = body;
  }
  return out;
}

// ── givens ─────────────────────────────────────────────────────────

/** Structural subset of malloy's GivenTypeDef union (not re-exported). */
type GivenTypeShape = {
  type: string;
  filterType?: string;
  elementTypeDef?: GivenTypeShape;
};

function renderGivenType(t: GivenTypeShape): string {
  if (t.type === 'filter expression') {
    return t.filterType ? `filter<${t.filterType}>` : 'filter';
  }
  if (t.type === 'array') {
    const elem = t.elementTypeDef;
    if (!elem) return 'array';
    if (elem.type === 'record_element') return 'record[]';
    return `${renderGivenType(elem)}[]`;
  }
  return t.type;
}

/** Structural subset of the malloy `Given` wrapper (not re-exported). */
type GivenLike = {
  readonly type: GivenTypeShape;
  readonly default: unknown;
  readonly location: MalloyLocation | undefined;
  readonly annotations: Annotations;
};

export function describeGiven(
  g: GivenLike,
  surfaceName: string,
  ctx?: Pick<WalkContext, 'rootUri' | 'readSource'>,
): GivenInfo {
  const annotations = annotationList(g.annotations);
  const info: GivenInfo = {
    name: surfaceName,
    type: renderGivenType(g.type),
    has_default: g.default !== undefined,
    description: descriptionOf(annotations),
  };
  if (annotations.length > 0) info.annotations = annotations;
  const loc = g.location;
  if (ctx && loc) {
    if (isLocal(loc, ctx.rootUri)) {
      const l = toLoc(loc);
      if (l) info.location = l;
    }
    const body = sliceSource(ctx.readSource(loc.url), loc);
    if (body) info.body = body;
  }
  return info;
}

function readQueryGivens(getPq: () => { givens: ReadonlyMap<string, unknown> }): string[] {
  try {
    return [...getPq().givens.keys()];
  } catch {
    return [];
  }
}

// ── model walk ─────────────────────────────────────────────────────

function walkModel(model: Model, rootUri: string, opts: CompileOptions,
  readSource: (href: string) => string | undefined): ModelInfo {
  const modelQueries = model.queries();
  // The public surface (exported sources) vs the full namespace. `exportedOnly`
  // (explore) keeps imports + unexported intermediates private; develop sees
  // everything. exportedExplores is absent on older malloy → fall back to all.
  const topLevel =
    (opts.exportedOnly ? model.exportedExplores : undefined) ?? model.explores;
  const knownSources = new Set<string>([
    ...topLevel.map((e) => e.name),
    ...modelQueries.named,
  ]);
  const ctx: WalkContext = { rootUri, knownSources, opts, readSource };

  const sources: Record<string, SourceInfo> = {};
  for (const e of topLevel) {
    sources[e.name] = walkExplore(e, ctx);
  }

  const queries: NamedQueryInfo[] = [];
  for (const queryName of modelQueries.named) {
    const pq = model.getPreparedQueryByName(queryName);
    const annotations = annotationList(pq.annotations);
    const info: NamedQueryInfo = {
      name: queryName,
      description: descriptionOf(annotations),
    };
    if (needsQuote(queryName)) info.mustQuote = true;
    if (annotations.length > 0) info.annotations = annotations;
    const loc = pq.location;
    if (isLocal(loc, rootUri)) {
      const l = toLoc(loc);
      if (l) info.location = l;
    }
    // Body follows the query's own file (across imports); location stays local.
    if (loc) {
      const body = sliceSource(readSource(loc.url), loc);
      if (body) info.body = body;
    }
    const givenNames = readQueryGivens(() => pq);
    if (givenNames.length > 0) info.givens = givenNames;
    queries.push(info);
  }

  const runs: RunStatementInfo[] = [];
  for (let idx = 0; idx < modelQueries.unnamed; idx++) {
    const pq = model.getPreparedQueryByIndex(idx);
    const info: RunStatementInfo = { index: idx };
    const annotations = annotationList(pq.annotations);
    if (annotations.length > 0) info.annotations = annotations;
    const l = toLoc(pq.location);
    if (l) info.location = l;
    try {
      const givenNames = [...pq.givens.keys()];
      if (givenNames.length > 0) info.givens = givenNames;
      if (opts.emitRunSql) info.sql = pq.preparedResult.sql.trim();
    } catch (e) {
      // Errors here only surface when SQL was requested (parity with
      // malloy-cli): otherwise silently omit givens for this run.
      if (opts.emitRunSql) info.error = e instanceof Error ? e.message : String(e);
    }
    runs.push(info);
  }

  const out: ModelInfo = { entry: rootUri, sources, queries, runs };
  const modelAnnotations = annotationList(model.annotations);
  if (modelAnnotations.length > 0) out.annotations = modelAnnotations;
  const givens: GivenInfo[] = [];
  for (const [surfaceName, g] of model.givens) {
    givens.push(describeGiven(g as unknown as GivenLike, surfaceName,
      { rootUri, readSource }));
  }
  if (givens.length > 0) out.givens = givens;
  return out;
}

/** Canonical-form check, normalized for line endings / trailing space. */
function isCanonicalForm(source: string): boolean | undefined {
  const { formatted, problems } = prettify(source);
  if (problems.length > 0) return undefined; // best-effort output — can't judge
  const norm = (s: string) => s.replace(/\r\n/g, '\n').trimEnd();
  return norm(formatted) === norm(source);
}

/**
 * Compile a model and return its full structured description (develop shape;
 * apply projectModel for the explore surface). Never throws on user-input failure.
 */
export async function compile(
  runtime: Runtime,
  entry: URL,
  opts: CompileOptions = {},
): Promise<CompileResult> {
  const readSource = opts.readSource ?? (() => undefined);
  try {
    const model = await runtime.loadModel(entry).getModel();
    try {
      const info = walkModel(model, entry.href, {
        expand: opts.expand ?? 'ref',
        emitRunSql: opts.emitRunSql ?? false,
        exportedOnly: opts.exportedOnly ?? false,
        readSource,
      }, readSource);
      const out: CompileResult = {
        ok: true,
        model: info,
        problems: mapProblems(model.problems),
      };
      // One-token canonical-form signal (vs echoing prettified text, which
      // would double the cost of every compile). Entry file only; absent
      // readSource (explore-bound describes) ⇒ omitted.
      const entryText = readSource(entry.href);
      if (entryText !== undefined) {
        const canonical = isCanonicalForm(entryText);
        if (canonical !== undefined) out.formatted = canonical;
      }
      return out;
    } catch (e) {
      return { ok: false, problems: [...mapProblems(model.problems), errorProblem(e, entry.href)] };
    }
  } catch (e) {
    if (e instanceof MalloyError) {
      return { ok: false, problems: mapProblems(e.problems) };
    }
    return { ok: false, problems: [errorProblem(e, entry.href)] };
  }
}

/** Cheap discovery: runnable things without full model serialization. */
export interface RunListing {
  ok: boolean;
  entry?: string;
  runs: Array<Pick<RunStatementInfo, 'index' | 'location' | 'annotations' | 'givens'>>;
  queries: Array<Pick<NamedQueryInfo, 'name' | 'location' | 'annotations' | 'givens'>>;
  problems: import('./types').Problem[];
}

export async function listRuns(runtime: Runtime, entry: URL): Promise<RunListing> {
  try {
    const model = await runtime.loadModel(entry).getModel();
    const modelQueries = model.queries();
    const runs = Array.from({ length: modelQueries.unnamed }, (_, idx) => {
      const pq = model.getPreparedQueryByIndex(idx);
      const e: RunListing['runs'][number] = { index: idx };
      const l = toLoc(pq.location);
      if (l) e.location = l;
      const annotations = annotationList(pq.annotations);
      if (annotations.length > 0) e.annotations = annotations;
      const givens = readQueryGivens(() => pq);
      if (givens.length > 0) e.givens = givens;
      return e;
    });
    const queries = modelQueries.named.map((name) => {
      const pq = model.getPreparedQueryByName(name);
      const e: RunListing['queries'][number] = { name };
      if (isLocal(pq.location, entry.href)) {
        const l = toLoc(pq.location);
        if (l) e.location = l;
      }
      const annotations = annotationList(pq.annotations);
      if (annotations.length > 0) e.annotations = annotations;
      const givens = readQueryGivens(() => pq);
      if (givens.length > 0) e.givens = givens;
      return e;
    });
    return { ok: true, entry: entry.href, runs, queries, problems: mapProblems(model.problems) };
  } catch (e) {
    if (e instanceof MalloyError) {
      return { ok: false, runs: [], queries: [], problems: mapProblems(e.problems) };
    }
    return { ok: false, runs: [], queries: [], problems: [errorProblem(e, entry.href)] };
  }
}
