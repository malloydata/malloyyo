// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Surface projection — pure functions. The walker always emits the full
// (develop) shape; the explore projection is the same shape with the
// develop-only fields stripped: location, body, entry, runs. Kept:
// expression, description, annotations, queries, givens.

import type {
  Annotation,
  ArrayStub,
  CompactField,
  CompactMember,
  CompactSchema,
  ExploreDescribedSource,
  ExploreDescription,
  ExploreField,
  ExploreFieldGroups,
  ExploreModelInfo,
  ExploreSourceDescribe,
  ExploreSourceInfo,
  FieldGroups,
  FieldInfo,
  GivenInfo,
  JoinEntry,
  JoinInfo,
  ModelInfo,
  NamedQueryInfo,
  SourceDescription,
  SourceInfo,
  Surface,
  ViewInfo,
} from './types';

/** Shallow copy without the given (optional) keys. Replaces the
    `const { x, ...rest } = o; void x;` discard idiom, which this lint config
    flags as an unused expression. */
function omit<T extends object, K extends keyof T>(o: T, ...keys: K[]): Omit<T, K> {
  const out: Record<string, unknown> = { ...(o as Record<string, unknown>) };
  for (const k of keys) delete out[k as string];
  return out as Omit<T, K>;
}

// The `'"'` (→ `description`) and `'agent'` (→ `instructions`) routes are
// already promoted into their own fields; drop them from `annotations[]` so the
// text isn't shipped twice. Every other route (render tags `#`, app-staked
// routes) is kept — no way to know what a client wants from them. The
// `annotations` key is omitted (not emitted empty) when nothing else remains.
function withoutDocRoute<T extends { annotations?: Annotation[] }>(x: T): T {
  if (!x.annotations) return x;
  const kept = x.annotations.filter((a) => a.route !== '"' && a.route !== 'agent');
  if (kept.length === x.annotations.length) return x;
  const base = omit(x, 'annotations') as T;
  return kept.length ? { ...base, annotations: kept } : base;
}

function projectField(f: FieldInfo): FieldInfo {
  return withoutDocRoute(omit(f, 'location'));
}

// On the explore surface, raw source text (`body`) and the develop-only
// `location` coordinate are stripped from the JSON — the source text is
// delivered as a separate clean Malloy content block instead.
function projectView(v: ViewInfo): ViewInfo {
  return withoutDocRoute(omit(v, 'location', 'body'));
}

type ProjectedJoin = Omit<JoinInfo, 'location' | 'body' | 'fields'> & {
  fields?: ExploreFieldGroups;
};

function projectJoin(j: JoinInfo): ProjectedJoin {
  const base = omit(j, 'location', 'body');
  const next: ProjectedJoin = base.fields
    ? { ...omit(base, 'fields'), fields: projectGroups(base.fields) }
    : omit(base, 'fields');
  return withoutDocRoute(next);
}

/** Collapse an array of named members into an object keyed by member name,
    dropping the now-redundant `name`. Built on a null-prototype object so a
    member named `__proto__` / `constructor` / `hasOwnProperty` / … lands as an
    ordinary data key instead of mutating the prototype or shadowing an
    inherited method — a name-keyed map of user-chosen identifiers is exactly
    where reserved names show up. Within a single group member names are unique,
    so no entry is lost. */
function byName<T extends { name: string }>(items: T[]): Record<string, Omit<T, 'name'>> {
  const out = Object.create(null) as Record<string, Omit<T, 'name'>>;
  for (const item of items) {
    out[item.name] = omit(item, 'name');
  }
  return out;
}

function projectGroups(g: FieldGroups): ExploreFieldGroups {
  return {
    dimensions: byName(g.dimensions.map(projectField)),
    measures: byName(g.measures.map(projectField)),
    views: byName(g.views.map(projectView)),
    joins: byName(g.joins.map(projectJoin)),
  };
}

export function projectSource(s: SourceInfo): ExploreSourceInfo {
  const base = omit(
    s, 'location', 'body', 'anon_srcs', 'dimensions', 'measures', 'views', 'joins',
  );
  const groups = projectGroups({
    dimensions: s.dimensions,
    measures: s.measures,
    views: s.views,
    joins: s.joins,
  });
  const projected = withoutDocRoute({ ...base, ...groups }) as ExploreSourceInfo;
  // anon_srcs are full sources (navigate-only) — project each the same way.
  // They stay an array: JoinInfo.anon_src_index addresses them positionally.
  if (s.anon_srcs) projected.anon_srcs = s.anon_srcs.map(projectSource);
  return projected;
}

export function projectGiven(g: GivenInfo): GivenInfo {
  return withoutDocRoute(omit(g, 'location', 'body'));
}

export function projectQuery(q: NamedQueryInfo): NamedQueryInfo {
  return withoutDocRoute(omit(q, 'location', 'body'));
}

export function projectModel(m: ModelInfo, surface: 'develop'): ModelInfo;
export function projectModel(m: ModelInfo, surface: 'explore'): ExploreModelInfo;
export function projectModel(m: ModelInfo, surface: Surface): ModelInfo | ExploreModelInfo;
export function projectModel(m: ModelInfo, surface: Surface): ModelInfo | ExploreModelInfo {
  if (surface === 'develop') return m;
  const sources: Record<string, ExploreSourceInfo> = {};
  for (const [name, s] of Object.entries(m.sources)) {
    sources[name] = projectSource(s);
  }
  const out: ExploreModelInfo = {
    sources,
    queries: m.queries.map(projectQuery),
    runs: [], // anonymous run: statements are not addressable from a explore surface
  };
  if (m.annotations) out.annotations = m.annotations;
  if (m.givens) out.givens = m.givens.map(projectGiven);
  return out;
}

export function projectDescription(d: SourceDescription, surface: 'develop'): SourceDescription;
export function projectDescription(d: SourceDescription, surface: 'explore'): ExploreDescription;
export function projectDescription(
  d: SourceDescription,
  surface: Surface,
): SourceDescription | ExploreDescription;
export function projectDescription(
  d: SourceDescription,
  surface: Surface,
): SourceDescription | ExploreDescription {
  if (surface === 'develop') return d;
  const sources: Record<string, ExploreSourceInfo> = {};
  for (const [name, s] of Object.entries(d.sources)) {
    sources[name] = projectSource(s);
  }
  return { requested: d.requested, sources };
}

// ── describe_source structured assembly (explore) — see the v5 spec ─
// COLUMNS (scalars → `dimensions` descriptors; single records → nested-`type`
// descriptors; arrays → a `dimensions` stub + a flat `joins` entry) vs JOINS
// (source relationships → flat `joins` entries only). `type` is always a real
// type; an array stub has no `type`. The flat `joins` list is the detail index;
// `join_source_map` is the deduped, relative-stub schema of every named source
// reached. Built from a compiled (develop) ModelInfo. Pure; no I/O.

const EMPTY_GROUPS: FieldGroups = { dimensions: [], measures: [], views: [], joins: [] };

/** A backtick-quoted-when-needed segment, for the QUOTED path form and view
    keys. Map keys (descriptor/stub keys, `joins` keys) stay the BARE name. */
const seg = (m: { name: string; must_quote?: boolean }): string =>
  m.must_quote ? `\`${m.name}\`` : m.name;
/** The clean (bare) dotted path — used as the `joins` key and a stub's `path`. */
const barePath = (prefix: string, j: JoinInfo): string =>
  prefix ? `${prefix}.${j.name}` : j.name;

/** The sliced join statement with its leading keyword restored (the slice starts
    at the handle name). `join_one`/`join_many`/`join_cross` per relationship. */
function joinCode(j: JoinInfo): string | undefined {
  if (!j.body) return undefined;
  const kw =
    j.relationship === 'one_to_many' ? 'join_many'
    : j.relationship === 'cross' ? 'join_cross'
    : 'join_one';
  return `${kw}: ${j.body}`;
}

/** A scalar/measure value descriptor: `{ type, …meta }`. */
function fieldDescriptor(f: FieldInfo): CompactField {
  const d: CompactField = { type: f.type };
  if (f.must_quote) d.must_quote = true;
  if (f.expression) d.expression = f.expression;
  if (f.description) d.description = f.description;
  if (f.instructions) d.instructions = f.instructions;
  return d;
}

/** The `dimensions` map for a set of fields: scalars and single records as
    full descriptors (records recurse into a nested `type`), arrays as stubs.
    Source-joins are NOT columns and are skipped here. `pathPrefix === null`
    yields relative array stubs (for deduped join_source_map entries); a string
    yields absolute `path`s. No emission — this only builds the column map. */
function buildColumns(
  groups: FieldGroups,
  pathPrefix: string | null,
): Record<string, CompactMember> {
  const out: Record<string, CompactMember> = Object.create(null);
  for (const f of groups.dimensions) out[f.name] = fieldDescriptor(f);
  for (const j of groups.joins) {
    if (j.column_shape === 'record') {
      const childPath = pathPrefix === null ? null : barePath(pathPrefix, j);
      const rec: CompactField = { type: buildColumns(j.fields ?? EMPTY_GROUPS, childPath) };
      if (j.must_quote) rec.must_quote = true;
      if (j.description) rec.description = j.description;
      if (j.instructions) rec.instructions = j.instructions;
      out[j.name] = rec;
    } else if (j.column_shape === 'scalar_array' || j.column_shape === 'record_array') {
      // `fans_out` here too — an array column always fans, and fans_out is the
      // single uniform cardinality signal (the consumer never re-derives it).
      // `path` is the CLEAN key into `joins` (where `quoted_path` lives if needed).
      const stub: ArrayStub = { is_array: true, fans_out: true };
      if (pathPrefix !== null) stub.path = barePath(pathPrefix, j);
      if (j.must_quote) stub.must_quote = true;
      out[j.name] = stub;
    }
    // source-joins: relationships, not columns — emitted into `joins` elsewhere.
  }
  return out;
}

function measuresMap(measures: FieldInfo[]): Record<string, CompactField> {
  const out: Record<string, CompactField> = Object.create(null);
  for (const m of measures) out[m.name] = fieldDescriptor(m);
  return out;
}

interface SchemaMeta {
  primary_key?: string | null;
  description?: string;
  instructions?: string;
}

/** A reached source's CompactSchema (columns + measures, no views). */
function buildSchema(
  groups: FieldGroups,
  pathPrefix: string | null,
  meta?: SchemaMeta,
): CompactSchema {
  const s = {} as CompactSchema;
  if (meta?.primary_key) s.primary_key = meta.primary_key;
  if (meta?.description) s.description = meta.description;
  if (meta?.instructions) s.instructions = meta.instructions;
  s.dimensions = buildColumns(groups, pathPrefix);
  s.measures = measuresMap(groups.measures);
  return s;
}

function viewsMap(views: ViewInfo[]): Record<string, string | null> {
  const out: Record<string, string | null> = Object.create(null);
  // null (not "") for a view with no description — distinguishes "no description"
  // from a deliberately blank one, and the value can't be omitted (it's the map
  // value, and the view must be listed so it's discoverable/invocable).
  for (const v of views) out[seg(v)] = v.description ?? null;
  return out;
}

interface EmitCtx {
  model: ModelInfo;
  /** Keyed by path; null-prototype so a reserved path is a safe data key. */
  joins: Record<string, JoinEntry>;
  map: Record<string, CompactSchema>;
}

/** Walk a set of fields, EMITTING flat `joins` entries for every array and
    source-join reached (records are recursed into, to surface their nested
    arrays/joins; scalars are ignored). `anonScope` is the anon_srcs array of the
    nearest enclosing NAMED source. */
function emitJoins(
  groups: FieldGroups,
  anonScope: SourceInfo[],
  bare: string,
  quoted: string,
  fans: boolean,
  namedOnPath: Set<string>,
  anonOnPath: Set<number>,
  ctx: EmitCtx,
): void {
  for (const j of groups.joins) {
    // The key is the CLEAN path; `quoted` is the parallel paste-ready form (only
    // attached as `quoted_path` when it actually differs).
    const cBare = barePath(bare, j);
    const cQuoted = quoted ? `${quoted}.${seg(j)}` : seg(j);
    if (j.column_shape === 'record') {
      // A single record fans nothing; recurse to emit any arrays/joins inside it.
      emitJoins(j.fields ?? EMPTY_GROUPS, anonScope, cBare, cQuoted, fans, namedOnPath, anonOnPath, ctx);
    } else if (j.column_shape === 'scalar_array' || j.column_shape === 'record_array') {
      emitArray(j, cBare, cQuoted, anonScope, namedOnPath, anonOnPath, ctx);
    } else {
      emitSourceJoin(j, cBare, cQuoted, anonScope, fans, namedOnPath, anonOnPath, ctx);
    }
  }
}

/** Attach `quoted_path` only when the quoted form differs from the clean key. */
function withQuoted(entry: JoinEntry, bare: string, quoted: string): JoinEntry {
  if (quoted !== bare) entry.quoted_path = quoted;
  return entry;
}

/** An array column → a `joins` entry (always `fans_out`), whose `source_def` is
    the element's schema (scalar arrays carry the single `each`). Nested
    arrays/joins inside the element are emitted too. Synthetic + finite → no cycle. */
function emitArray(
  j: JoinInfo,
  bare: string,
  quoted: string,
  anonScope: SourceInfo[],
  namedOnPath: Set<string>,
  anonOnPath: Set<number>,
  ctx: EmitCtx,
): void {
  const fields = j.fields ?? EMPTY_GROUPS;
  // `fans_out` is the total cardinality signal — set it on the array too (not
  // only on source-joins), so "does it fan" always has one place to look. Its
  // descendants also inherit fans=true.
  ctx.joins[bare] = withQuoted({ is_array: true, fans_out: true, source_def: buildSchema(fields, bare) }, bare, quoted);
  emitJoins(fields, anonScope, bare, quoted, true, namedOnPath, anonOnPath, ctx);
}

/** A source-join → a `joins` entry. Named → `source` ref (+ schema into the
    deduped map, with relative stubs) and recurse into the target. Un-nameable
    (anon import / own sql-or-query block) → inline `source_def`. */
function emitSourceJoin(
  j: JoinInfo,
  bare: string,
  quoted: string,
  anonScope: SourceInfo[],
  fans: boolean,
  namedOnPath: Set<string>,
  anonOnPath: Set<number>,
  ctx: EmitCtx,
): void {
  const entryFans = fans || j.relationship !== 'many_to_one';
  const entry: JoinEntry = {};
  if (entryFans) entry.fans_out = true;
  withQuoted(entry, bare, quoted);

  if (j.source_ref) {
    entry.source = j.source_ref;
    const namedCode = joinCode(j);
    if (namedCode) entry.code = namedCode;
    const target = ctx.model.sources[j.source_ref];
    if (target && !(j.source_ref in ctx.map)) {
      ctx.map[j.source_ref] = buildSchema(target, null, target); // deduped, relative stubs
    }
    if (namedOnPath.has(j.source_ref)) {
      entry.cycle = true;
      ctx.joins[bare] = entry;
      return;
    }
    ctx.joins[bare] = entry;
    if (target) {
      emitJoins(
        target, target.anon_srcs ?? [], bare, quoted, entryFans,
        new Set([...namedOnPath, j.source_ref]), new Set(), ctx,
      );
    }
    return;
  }

  // Un-nameable target.
  let fields: FieldGroups | undefined;
  let meta: SchemaMeta | undefined;
  let anonIdx: number | undefined;
  if (j.anon_src_index !== undefined) {
    anonIdx = j.anon_src_index;
    const a = anonScope[anonIdx];
    if (a) { fields = a; meta = a; }
  } else if (j.fields) {
    fields = j.fields;
    meta = { description: j.description, instructions: j.instructions };
  }
  if (fields) entry.source_def = buildSchema(fields, bare, meta);
  const anonCode = joinCode(j);
  if (anonCode) entry.code = anonCode;
  if (anonIdx !== undefined && anonOnPath.has(anonIdx)) {
    entry.cycle = true;
    ctx.joins[bare] = entry;
    return;
  }
  ctx.joins[bare] = entry;
  if (fields) {
    emitJoins(
      fields, anonScope, bare, quoted, entryFans, namedOnPath,
      anonIdx !== undefined ? new Set([...anonOnPath, anonIdx]) : anonOnPath, ctx,
    );
  }
}

/**
 * Assemble the structured describe_source surface for `name` from a compiled
 * ModelInfo. Returns undefined when the model has no such source. Pure; no I/O.
 * (The Malloy-text appendix is assembled separately by the caller.)
 */
export function buildSourceDescribe(
  model: ModelInfo,
  name: string,
): ExploreSourceDescribe | undefined {
  const root = model.sources[name];
  if (!root) return undefined;
  const ctx: EmitCtx = { model, joins: Object.create(null), map: Object.create(null) };
  const described_source: ExploreDescribedSource = {
    name,
    ...buildSchema(root, '', root),
    views: viewsMap(root.views),
  };
  emitJoins(root, root.anon_srcs ?? [], '', '', false, new Set([name]), new Set(), ctx);
  return { described_source, joins: ctx.joins, join_source_map: ctx.map };
}
