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
    return await executeMaterialized(q, opts, loadProblems, (p) => p, entry.href);
  } catch (e) {
    if (e instanceof MalloyError) {
      return { ok: false, problems: [...loadProblems, ...mapProblems(e.problems)] };
    }
    return { ok: false, problems: [...loadProblems, errorProblem(e, entry.href)] };
  }
}
