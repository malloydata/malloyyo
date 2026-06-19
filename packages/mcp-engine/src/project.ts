// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Surface projection — pure functions. The walker always emits the full
// (develop) shape; the explore projection is the same shape with the
// develop-only fields stripped: location, body, entry, runs. Kept:
// expression, description, annotations, queries, givens.

import type {
  Annotation,
  ExploreDescription,
  ExploreFieldGroups,
  ExploreModelInfo,
  ExploreSourceInfo,
  FieldGroups,
  FieldInfo,
  GivenInfo,
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
