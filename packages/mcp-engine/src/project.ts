// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Surface projection — pure functions. The walker always emits the full
// (develop) shape; the explore projection is the same shape with the
// develop-only fields stripped: location, body, entry, runs. Kept:
// expression, description, annotations, queries, givens.

import type {
  Annotation,
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

// The `'"'` (doc-string) route is already promoted into `description`; on the
// explore surface drop it from `annotations[]` so the doc text isn't shipped
// twice. Every other route (render tags `#`, app-staked routes) is kept — no
// way to know what a client wants from them. The `annotations` key is omitted
// (not emitted empty) when nothing else remains.
function withoutDocRoute<T extends { annotations?: Annotation[] }>(x: T): T {
  if (!x.annotations) return x;
  const kept = x.annotations.filter((a) => a.route !== '"');
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

function projectJoin(j: JoinInfo): JoinInfo {
  const base = omit(j, 'location', 'body');
  const next = base.fields ? { ...base, fields: projectGroups(base.fields) } : base;
  return withoutDocRoute(next);
}

function projectGroups(g: FieldGroups): FieldGroups {
  return {
    dimensions: g.dimensions.map(projectField),
    measures: g.measures.map(projectField),
    views: g.views.map(projectView),
    joins: g.joins.map(projectJoin),
  };
}

export function projectSource(s: SourceInfo): SourceInfo {
  const base = omit(s, 'location', 'body', 'dimensions', 'measures', 'views', 'joins');
  const groups = projectGroups({
    dimensions: s.dimensions,
    measures: s.measures,
    views: s.views,
    joins: s.joins,
  });
  return withoutDocRoute({ ...base, ...groups });
}

export function projectGiven(g: GivenInfo): GivenInfo {
  return withoutDocRoute(omit(g, 'location', 'body'));
}

export function projectQuery(q: NamedQueryInfo): NamedQueryInfo {
  return withoutDocRoute(omit(q, 'location', 'body'));
}

export function projectModel(m: ModelInfo, surface: Surface): ModelInfo {
  if (surface === 'develop') return m;
  const sources: Record<string, SourceInfo> = {};
  for (const [name, s] of Object.entries(m.sources)) {
    sources[name] = projectSource(s);
  }
  const out: ModelInfo = {
    sources,
    queries: m.queries.map(projectQuery),
    runs: [], // anonymous run: statements are not addressable from a explore surface
  };
  if (m.annotations) out.annotations = m.annotations;
  if (m.givens) out.givens = m.givens.map(projectGiven);
  return out;
}

export function projectDescription(
  d: SourceDescription,
  surface: Surface,
): SourceDescription {
  if (surface === 'develop') return d;
  const sources: Record<string, SourceInfo> = {};
  for (const [name, s] of Object.entries(d.sources)) {
    sources[name] = projectSource(s);
  }
  return { requested: d.requested, sources };
}
