// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The explore-surface execution path. Both functions enforce core's restricted
// mode (loadRestrictedQuery): no import, no given: declarations, no
// connection.table/sql, no raw-SQL forms, no ##! flags — rejected with
// 'restricted-construct-forbidden'. "Restricted" stays in these names so an
// implementer cannot silently route explore-surface input through the open run.

import type { Runtime } from '@malloydata/malloy';
import { MalloyError } from '@malloydata/malloy';
import { errorProblem, hasError, mapProblems } from './problems';
import type { RunOptions } from './run';
import { executeMaterialized } from './run';
import { describeGiven } from './walker';
import type { GivenInfo, Problem, QueryValidationResult, RunResult } from './types';

/**
 * The full given detail for the givens a compiled query transitively
 * references — the authoritative per-query answer to "what must I supply."
 */
async function queryGivens(
  q: { getPreparedQuery(): Promise<unknown> },
): Promise<GivenInfo[] | undefined> {
  try {
    const pq = (await q.getPreparedQuery()) as {
      givens: ReadonlyMap<string, unknown>;
    };
    const out: GivenInfo[] = [];
    for (const [name, g] of pq.givens) {
      out.push(describeGiven(g as Parameters<typeof describeGiven>[0], name));
    }
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The query's input source, named so a caller can look it up in the model
 * namespace. Uses Malloy's experimental `Explore.referencedSource()`: it returns
 * the namespace source the query's FROM-source references (read `.name`), or
 * undefined when that source defines its own shape / is not nameable in the
 * namespace. We do NOT trust `sourceExplore.name` directly — there is no
 * guarantee the query's source name is a name in the model namespace. Best
 * effort; undefined on any failure (including a query that did not compile).
 */
async function querySource(q: { getPreparedResult(): Promise<unknown> }): Promise<string | undefined> {
  try {
    const pr = (await q.getPreparedResult()) as {
      sourceExplore?: { referencedSource?(): { name?: string } | undefined };
    };
    return pr.sourceExplore?.referencedSource?.()?.name;
  } catch {
    return undefined;
  }
}

/** Validate restricted query text against the model. No execution. */
export async function validateRestricted(
  runtime: Runtime,
  entry: URL,
  query: string,
): Promise<QueryValidationResult> {
  let loadProblems: Problem[];
  let materializer;
  try {
    materializer = runtime.loadModel(entry);
    const model = await materializer.getModel();
    loadProblems = mapProblems(model.problems);
  } catch (e) {
    if (e instanceof MalloyError) {
      return { ok: false, problems: mapProblems(e.problems) };
    }
    return { ok: false, problems: [errorProblem(e, entry.href)] };
  }
  try {
    const q = materializer.loadRestrictedQuery(query);
    const problems = [...loadProblems, ...mapProblems(await q.validate())];
    const ok = !hasError(problems);
    const out: QueryValidationResult = { ok, problems };
    if (ok) {
      // execute:false returns the generated SQL (compile without running) plus
      // the givens the query references — the confirmatory-inspect channel.
      try { out.sql = (await q.getSQL()).trim(); } catch { /* keep sql absent on a late compile error */ }
      const givens = await queryGivens(q);
      if (givens) out.givens = givens;
    }
    return out;
  } catch (e) {
    if (e instanceof MalloyError) {
      return { ok: false, problems: [...loadProblems, ...mapProblems(e.problems)] };
    }
    return { ok: false, problems: [...loadProblems, errorProblem(e, entry.href)] };
  }
}

/** Compile restricted query text against the model and execute it. */
export async function runRestricted(
  runtime: Runtime,
  entry: URL,
  query: string,
  opts: Pick<RunOptions, 'rowLimit' | 'givens' | 'stableResult' | 'retry'> = {},
): Promise<RunResult> {
  let loadProblems: Problem[];
  let materializer;
  try {
    materializer = runtime.loadModel(entry);
    const model = await materializer.getModel();
    loadProblems = mapProblems(model.problems);
  } catch (e) {
    if (e instanceof MalloyError) {
      return { ok: false, problems: mapProblems(e.problems) };
    }
    return { ok: false, problems: [errorProblem(e, entry.href)] };
  }
  try {
    const q = materializer.loadRestrictedQuery(query);
    const result = await executeMaterialized(q, opts, loadProblems, (p) => p, entry.href);
    // Derive the input source (model-centric query takes no `source` param) so a
    // host can record what was queried. Only meaningful on a successful compile.
    if (result.ok) {
      const source = await querySource(q);
      if (source) result.source = source;
    }
    return result;
  } catch (e) {
    if (e instanceof MalloyError) {
      return { ok: false, problems: [...loadProblems, ...mapProblems(e.problems)] };
    }
    return { ok: false, problems: [...loadProblems, errorProblem(e, entry.href)] };
  }
}
