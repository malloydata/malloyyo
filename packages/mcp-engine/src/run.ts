// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Execution helpers. `run` is the open/develop path (file or inline source,
// name/index/final selection). The shared executor is also used by the
// restricted path. Helpers never throw on user-input failure.

import type { GivenValue, QueryMaterializer, Runtime } from '@malloydata/malloy';
import { API, MalloyError } from '@malloydata/malloy';
import { codeProblem, errorProblem, mapProblems } from './problems';
import type { Problem, RunResult } from './types';

export const DEFAULT_ROW_LIMIT = 10_000;

export interface RunOptions {
  /** Selection: `runExpr` (run this as `run: <expr>` — a query name or a
      `<source> -> <view>` path; the dashboard path) wins, else `name` (a
      query: definition), else `index` (0-based into run: statements), else
      the final run:. */
  runExpr?: string;
  name?: string;
  index?: number;
  /** Memory/transfer cap, not a context cap (that is the byte budget's job). */
  rowLimit?: number;
  /** Given values keyed by surface name, as they arrive off the wire (JSON,
      so `unknown`-valued). Coerced to Malloy's `GivenValue` at the compile seam
      below — the compiler is the validator, so callers don't pre-narrow. */
  givens?: Record<string, unknown>;
  /** Attach the interfaces-format result (API.util.wrapResult) as
      `stable_result` — for host renderers, never sent over MCP. */
  stableResult?: boolean;
  /** Wrap query execution (e.g. DuckDB file-lock retry). Default: run once. */
  retry?: <T>(op: () => Promise<T>) => Promise<T>;
}

type ExecOptions = Pick<RunOptions, 'rowLimit' | 'givens' | 'stableResult' | 'retry'>;

/**
 * Run a materialized query and shape the uniform RunResult. Shared by the
 * open `run` and the restricted run path.
 */
export async function executeMaterialized(
  query: QueryMaterializer,
  opts: ExecOptions,
  loadProblems: Problem[],
  decorate: (p: Problem) => Problem = (p) => p,
  uri?: string,
): Promise<RunResult> {
  const rowLimit = opts.rowLimit ?? DEFAULT_ROW_LIMIT;
  const retry = opts.retry ?? (<T>(op: () => Promise<T>) => op());
  // The one wire→Malloy coercion for givens: values are user JSON, validated by
  // the compiler when it binds them (a bad value surfaces as a compile problem).
  const compileOpts = opts.givens
    ? { givens: opts.givens as Record<string, GivenValue> }
    : undefined;
  try {
    const t0 = Date.now();
    const sql = (await query.getSQL(compileOpts)).trim();
    const t1 = Date.now();
    const results = await retry(() => query.run({ rowLimit, ...compileOpts }));
    const t2 = Date.now();
    const rows = results.toJSON().queryResult.result;
    const out: RunResult = {
      ok: true,
      sql,
      rows,
      row_count: rows.length,
      rows_returned: rows.length,
      compile_time_ms: t1 - t0,
      total_time_ms: t2 - t0,
      problems: loadProblems,
    };
    if (rows.length === rowLimit) {
      out.truncated = {
        reason: 'row_limit',
        hint:
          `Result hit the ${rowLimit}-row limit; more rows may exist. ` +
          'Aggregate, filter, or do top-N in Malloy rather than fetching ' +
          'rows to post-process.',
      };
    }
    if (opts.stableResult) out.stable_result = API.util.wrapResult(results);
    return out;
  } catch (e) {
    if (e instanceof MalloyError) {
      return { ok: false, problems: [...loadProblems, ...mapProblems(e.problems).map(decorate)] };
    }
    return { ok: false, problems: [...loadProblems, errorProblem(e, uri)] };
  }
}

/**
 * Execute one run:/query from a model. Selection failures list what IS
 * available so the agent can retry without another round trip.
 */
export async function run(
  runtime: Runtime,
  entry: URL,
  opts: RunOptions = {},
): Promise<RunResult> {
  let materializer;
  let modelQueries: { named: string[]; unnamed: number };
  let loadProblems: Problem[];
  try {
    materializer = runtime.loadModel(entry);
    const model = await materializer.getModel();
    modelQueries = { named: [...model.queries().named], unnamed: model.queries().unnamed };
    loadProblems = mapProblems(model.problems);
  } catch (e) {
    if (e instanceof MalloyError) {
      return { ok: false, problems: mapProblems(e.problems) };
    }
    return { ok: false, problems: [errorProblem(e, entry.href)] };
  }

  let query: QueryMaterializer;
  if (opts.runExpr !== undefined) {
    // Dashboard selection: a query name or `<source> -> <view>` — both are
    // valid after `run:`. Compile/bind errors surface via executeMaterialized.
    query = materializer.loadQuery(`run: ${opts.runExpr}`);
  } else if (opts.name !== undefined) {
    if (!modelQueries.named.includes(opts.name)) {
      return {
        ok: false,
        problems: [
          codeProblem(
            'selector-not-found',
            `No query named '${opts.name}'. Available: ` +
              JSON.stringify({ queries: modelQueries.named, runs: modelQueries.unnamed }),
            entry.href,
          ),
        ],
      };
    }
    query = materializer.loadQueryByName(opts.name);
  } else if (typeof opts.index === 'number') {
    if (opts.index < 0 || opts.index >= modelQueries.unnamed) {
      return {
        ok: false,
        problems: [
          codeProblem(
            'selector-out-of-range',
            `Index ${opts.index} out of range; the model has ` +
              `${modelQueries.unnamed} run: statement(s).`,
            entry.href,
          ),
        ],
      };
    }
    query = materializer.loadQueryByIndex(opts.index);
  } else {
    if (modelQueries.unnamed === 0) {
      return {
        ok: false,
        problems: [
          codeProblem(
            'no-run',
            'The source has no run: statement. Specify a named query via ' +
              '`name`, or add a run: to the source.',
            entry.href,
          ),
        ],
      };
    }
    query = materializer.loadFinalQuery();
  }

  return executeMaterialized(query, opts, loadProblems, (p) => p, entry.href);
}
