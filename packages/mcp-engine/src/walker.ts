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
function descriptionOf(a: Annotations | undefined): string | undefined {
  // forRoute('"') is Malloy's sanctioned reader for the doc-string channel
  // (excludes malformed routes; returns inherited+local notes, inherited-first).
  const docs = (a?.forRoute('"') ?? []).map((n) => n.content.trim()).filter(Boolean);
  return docs.length ? docs.join('\n') : undefined;
}

/** Promote the agent route (`#(agent) …`) to `instructions` — the "instructions
    for agents using this object" channel — every `#(agent)` line in source
    order, joined. Distinct from the human `description` (`#"`). */
function agentNotesOf(a: Annotations | undefined): string | undefined {
  // `#(agent) …` stakes the app route `agent` (Malloy's bracketed-route
  // mechanism); forRoute('agent') is the sanctioned reader for its content.
  const notes = (a?.forRoute('agent') ?? []).map((n) => n.content.trim()).filter(Boolean);
  return notes.length ? notes.join('\n') : undefined;
}

/** Apply the two annotation channels onto an object: `description` (doc route)
    and `instructions` (agent route). Each is set only when present — never a
    null/empty key (token economy on field lists). */
function applyDocs<T extends { description?: string; instructions?: string }>(
  obj: T,
  a: Annotations | undefined,
): T {
  const d = descriptionOf(a);
  if (d) obj.description = d;
  const i = agentNotesOf(a);
  if (i) obj.instructions = i;
  return obj;
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

function joinRel(ef: ExploreField): 'one_to_many' | 'many_to_one' | 'cross' {
  // join_one → at most one joined row per source row (no fan-out) = many:one;
  // join_many → many joined rows per source row (fan-out) = one:many.
  const j = (ef.structDef as { join?: string }).join;
  if (j === 'many') return 'one_to_many';
  if (j === 'cross') return 'cross';
  return 'many_to_one';
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

/**
 * What a join's target IS, resolved from Malloy's authoritative reference
 * tracking (the experimental `referenceSourceID` / `referencedSource()` pair)
 * rather than guessed from structDef shape:
 *  - 'ref'  — an unmodified reference to a source that is named in this model's
 *             namespace and is a known top-level source → emit `source_ref`.
 *  - 'anon' — an unmodified reference to a source that CANNOT be named here
 *             (reached only through a transitive import) → emit `anon_src_index`
 *             into the owning source's `anon_srcs`, deduped by `refId`.
 *  - 'own'  — the join defines its own shape (table, SQL, query, nested/repeated
 *             record, or a modified/extended source — no source to reference),
 *             OR names a private/unexported source we deliberately don't surface
 *             → inline its fields.
 */
type JoinClass =
  | { kind: 'ref'; name: string }
  | { kind: 'anon'; refId: string }
  | { kind: 'own' };

/** `referencedSource()` is experimental and can throw; never let it break a
    describe — an unresolved reference degrades to inline. */
function safeReferencedSource(ef: ExploreField): Explore | undefined {
  try {
    return (ef as { referencedSource?: () => Explore | undefined }).referencedSource?.();
  } catch {
    return undefined;
  }
}

function classifyJoinTarget(ef: ExploreField, knownSources: Set<string>): JoinClass {
  // Undefined ⇒ this join defines its own shape (incl. nested/repeated records
  // and scalar arrays, which report no referenceID) → inline.
  const refId = (ef as { referenceSourceID?: string }).referenceSourceID;
  if (refId === undefined) return { kind: 'own' };
  const ref = safeReferencedSource(ef);
  if (ref) {
    // Nameable here. Reference it only if it is an addressable top-level source;
    // a private/unexported target can't be addressed, so inline it.
    if (knownSources.has(ref.name)) return { kind: 'ref', name: ref.name };
    return { kind: 'own' };
  }
  // A real reference, but to a source not nameable in this namespace → anon.
  return { kind: 'anon', refId };
}

/** Per-source accumulator for un-nameable join targets: `byId` dedups by
    `referenceSourceID`; `srcs` is the source's `anon_srcs` array. */
interface AnonAcc {
  byId: Map<string, number>;
  srcs: SourceInfo[];
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

/** Allocate (or reuse) an `anon_srcs` slot for an un-nameable join target.
    Reserves the index BEFORE walking the target's fields so a cyclic/self
    reference reuses the in-progress slot instead of recursing forever. */
function allocAnon(
  ef: ExploreField,
  refId: string,
  depth: number,
  ctx: WalkContext,
  anon: AnonAcc,
): number {
  const existing = anon.byId.get(refId);
  if (existing !== undefined) return existing;
  const idx = anon.srcs.length;
  anon.byId.set(refId, idx);
  // Reserve the slot, then fill it (cycle-safe).
  anon.srcs.push(undefined as unknown as SourceInfo);
  anon.srcs[idx] = buildAnonSource(ef, refId, depth, ctx, anon);
  return idx;
}

/** An un-nameable join target rendered as a SourceInfo. The name is cosmetic
    (it has no writable name here) — derive a readable label from the reference
    id (`carriers@file://…` → `carriers`). No location/body: the join's own
    location points at the join statement, not the target's defining file. */
function buildAnonSource(
  ef: ExploreField,
  refId: string,
  depth: number,
  ctx: WalkContext,
  anon: AnonAcc,
): SourceInfo {
  const structDefFields = (ef.structDef.fields as StructDefField[]) ?? [];
  const groups = walkFields(ef.allFields, structDefFields, depth, ctx, anon);
  const name = refId.split('@')[0] || ef.name;
  const out: SourceInfo = {
    name,
    primary_key: (ef as { primaryKey?: string }).primaryKey ?? null,
    ...groups,
  };
  applyDocs(out, ef.annotations);
  if (needsQuote(name)) out.mustQuote = true;
  const annotations = annotationList(ef.annotations);
  if (annotations.length > 0) out.annotations = annotations;
  return out;
}

function walkFields(
  fields: Field[],
  structDefFields: StructDefField[],
  depth: number,
  ctx: WalkContext,
  anon: AnonAcc,
): FieldGroups {
  const groups = emptyGroups();
  for (const f of fields) {
    const annotations = annotationList(f.annotations);
    const mLoc = f.location as MalloyLocation | undefined;
    const local = isLocal(mLoc, ctx.rootUri);
    const loc = local ? toLoc(mLoc) : undefined;

    if (f.isExploreField()) {
      const ef = f as ExploreField;
      const cls = classifyJoinTarget(ef, ctx.knownSources);
      const inlineMode = ctx.opts.expand === 'inline';
      const join: JoinInfo = { name: f.name, relationship: joinRel(ef) };
      applyDocs(join, f.annotations);
      if (cls.kind === 'ref') join.source_ref = cls.name;
      // Anonymous targets live in the owning source's anon_srcs; in inline mode
      // we inline their fields instead, so don't also allocate a slot.
      else if (cls.kind === 'anon' && !inlineMode) {
        join.anon_src_index = allocAnon(ef, cls.refId, depth + 1, ctx, anon);
      }
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

      // Inline when the target defines its own shape (nothing to reference), or
      // when the client asked for inline expansion. Ref'd and anon targets are
      // navigated, not inlined.
      const shouldInline = inlineMode || cls.kind === 'own';
      if (shouldInline && depth < MAX_JOIN_DEPTH) {
        const childStructFields =
          (ef.structDef.fields as StructDefField[]) ?? [];
        const sub = walkFields(ef.allFields, childStructFields, depth + 1, ctx, anon);
        join.fields = stripScalarArrayValue(ef, sub);
      }
      groups.joins.push(join);
      continue;
    }

    if (f.isQueryField()) {
      // A QueryField's "expression" is just the view name, so we never read it;
      // the view is described by its name + sliced body, not an expression.
      const view: ViewInfo = { name: f.name };
      applyDocs(view, f.annotations);
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
      groups.views.push(view);
      continue;
    }

    const af = f as AtomicField;
    const info: FieldInfo = { name: f.name, type: af.type };
    applyDocs(info, f.annotations);
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
  // Fresh accumulator per top-level source: anon_srcs and their dedup are
  // scoped to the source that owns the un-nameable joins.
  const anon: AnonAcc = { byId: new Map(), srcs: [] };
  const groups = walkFields(e.allFields, structDefFields, 0, ctx, anon);
  const annotations = annotationList(e.annotations);
  const out: SourceInfo = {
    name: e.name,
    primary_key: e.primaryKey ?? null,
    ...groups,
  };
  applyDocs(out, e.annotations);
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
  if (anon.srcs.length > 0) out.anon_srcs = anon.srcs;
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
  };
  applyDocs(info, g.annotations);
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
    const info: NamedQueryInfo = { name: queryName };
    applyDocs(info, pq.annotations);
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
