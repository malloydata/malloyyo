// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import type { LogMessage } from '@malloydata/malloy';
import { helpTopicForCode } from './help';
import type { Problem } from './types';

/** Map malloy's log messages onto the uniform wire Problem shape. */
export function mapProblems(problems: LogMessage[]): Problem[] {
  return problems.map((p) => {
    const out: Problem = {
      severity: p.severity,
      message: p.message,
      code: p.code,
      uri: p.at?.url,
      line: p.at?.range.start.line,
      column: p.at?.range.start.character,
      end_line: p.at?.range.end.line,
      end_column: p.at?.range.end.character,
    };
    const topic = helpTopicForCode(p.code);
    if (topic) out.help_topic = topic;
    return out;
  });
}

export function errorProblem(e: unknown, uri?: string): Problem {
  return {
    severity: 'error',
    message: e instanceof Error ? e.message : String(e),
    code: 'internal-error',
    uri,
  };
}

/** Engine-level problem with a code (and help_topic when one maps). */
export function codeProblem(code: string, message: string, uri?: string): Problem {
  const out: Problem = { severity: 'error', code, message, uri };
  const topic = helpTopicForCode(code);
  if (topic) out.help_topic = topic;
  return out;
}

export function hasError(problems: Problem[]): boolean {
  return problems.some((p) => p.severity === 'error');
}

/**
 * Apply config-level problems to a tool call — the shared policy every
 * engine-based host uses so a bad connection config behaves identically
 * across surfaces and servers (the develop server and the hosted query
 * server alike). Config *loading* is host territory (a local file, a
 * published bundle, a DB row); this is the congruent *reaction* to whatever
 * the host loaded, applied at the host's per-call lease (withRuntime /
 * withModel):
 *
 *   - any `severity:'error'` among `configProblems` → SHORT-CIRCUIT: `run`
 *     never executes, so nothing compiles against a broken/empty config and
 *     the misleading field-not-found cascade never spills; the config
 *     problems ARE the result.
 *   - otherwise `run` executes and any warnings are prepended to the
 *     result's `problems[]`, riding along without blocking.
 *
 * The `{ ok:false, problems }` short-circuit shape is the common envelope of
 * every tool result; surfaces forward it untouched. (Engine rule: a bad
 * config is user input — it becomes problems[], never a throw.)
 */
export async function gateConfigProblems<T>(
  configProblems: Problem[],
  run: () => Promise<T>,
): Promise<T> {
  if (hasError(configProblems)) {
    return { ok: false, problems: configProblems } as unknown as T;
  }
  const result = await run();
  if (configProblems.length === 0) return result;
  const r = result as unknown as { problems?: Problem[] };
  if (Array.isArray(r.problems)) {
    return { ...result, problems: [...configProblems, ...r.problems] } as T;
  }
  return result;
}
