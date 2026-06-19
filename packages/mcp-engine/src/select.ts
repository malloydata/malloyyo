// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// describe-source selection: the requested source plus the deduped
// transitive join closure, computed purely from an already-compiled
// ModelInfo. The closure is built by RESOLVING refs against the single
// compiled model — never by discovery (resolution-primary, principle 2).

import type { Runtime } from '@malloydata/malloy';
import type { CompileOptions } from './walker';
import { compile } from './walker';
import { codeProblem } from './problems';
import type {
  DescribeResult,
  FieldGroups,
  ModelInfo,
  SourceDescription,
  SourceInfo,
} from './types';

/** Collect every source_ref reachable in a group tree (inline join groups
    can themselves contain ref'd joins). */
function collectRefs(groups: FieldGroups, into: Set<string>): void {
  for (const j of groups.joins) {
    if (j.source_ref) into.add(j.source_ref);
    if (j.fields) collectRefs(j.fields, into);
  }
}

/** A source's own joins plus the joins of every anon source it owns — an anon
    (un-nameable) target can still join a source that IS nameable here, and that
    nameable target belongs in the closure. */
function collectSourceRefs(s: SourceInfo, into: Set<string>): void {
  collectRefs(s, into);
  for (const a of s.anon_srcs ?? []) collectSourceRefs(a, into);
}

/**
 * Pure selection: requested source + transitive join closure. No I/O.
 * Returns undefined when the model has no such source.
 */
export function selectSource(
  model: ModelInfo,
  name: string,
): SourceDescription | undefined {
  const root = model.sources[name];
  if (!root) return undefined;
  const sources: Record<string, SourceInfo> = {};
  const queue = [name];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined || sources[next]) continue;
    const info = model.sources[next];
    if (!info) continue; // a ref may name something outside sources{} (rare)
    sources[next] = info;
    const refs = new Set<string>();
    collectSourceRefs(info, refs);
    for (const r of refs) if (!sources[r]) queue.push(r);
  }
  return { requested: name, sources };
}

/** Convenience: compile + selectSource. */
export async function describeSource(
  runtime: Runtime,
  entry: URL,
  name: string,
  opts?: CompileOptions,
): Promise<DescribeResult> {
  const compiled = await compile(runtime, entry, opts);
  if (!compiled.ok || !compiled.model) {
    return { ok: false, problems: compiled.problems };
  }
  const description = selectSource(compiled.model, name);
  if (!description) {
    const available = Object.keys(compiled.model.sources);
    return {
      ok: false,
      problems: [
        codeProblem(
          'source-not-found',
          `No source named '${name}' in this model. Sources that exist: ` +
            `${available.join(', ') || '(none)'}.`,
          entry.href,
        ),
      ],
    };
  }
  return { ok: true, description, problems: compiled.problems };
}
