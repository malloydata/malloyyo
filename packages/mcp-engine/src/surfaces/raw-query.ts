// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The opt-in raw-query tool: one read-only SQL statement, straight at the
// model's own connection. This is the guided-SQL escape hatch for models whose
// guidance topics speak SQL (canonical patterns over warehouse tables the
// Malloy sources don't cover) — the model AUTHOR enables it per model; it is
// never on by default. The engine owns the gate (sql-guard.ts) and the tool
// shape; the host owns connection lease + execution, exactly as everywhere
// else in this engine.

import { codeProblem } from '../problems';
import { prompts } from '../prompts';
import { checkSelectOnly } from '../sql-guard';
import { argOptNumber, argOptString, argString, type ToolDef } from './shared';

export const RAW_QUERY_DEFAULT_ROWS = 100;
export const RAW_QUERY_MAX_ROWS = 1000;

/** What the host returns from one executed statement. `total_rows`, when the
    backend reports it, lets the tool flag truncation honestly. */
export interface RawQueryRows {
  rows: Record<string, unknown>[];
  total_rows?: number;
}

export interface RawQueryHost {
  /**
   * Execute one already-guarded read-only statement on the connection of the
   * model `ref` names (undefined → the host's only raw-query-enabled model;
   * throw if that is ambiguous). Throw on refusal or database error — the tool
   * surfaces the message as a problem so the caller can self-correct.
   */
  runSQL(ref: string | undefined, sql: string, rowLimit: number): Promise<RawQueryRows>;
}

export function rawQueryTool(host: RawQueryHost): ToolDef {
  return {
    name: 'run_query',
    title: prompts.shared.tools.run_query.title,
    description: prompts.shared.tools.run_query.description,
    inputSchema: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description: 'One read-only SQL statement (SELECT/WITH/FROM). No trailing statements.',
        },
        model_ref: {
          type: 'string',
          description:
            'The model whose connection to run on (optional when only one model enables raw queries).',
        },
        question: {
          type: 'string',
          description: 'Plain-English description of what this query answers; hosts may record it.',
        },
        max_rows: {
          type: 'integer',
          minimum: 1,
          maximum: RAW_QUERY_MAX_ROWS,
          description: `Row cap (default ${RAW_QUERY_DEFAULT_ROWS}).`,
        },
      },
      required: ['sql'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const sql = argString(args, 'sql');
      const rejected = checkSelectOnly(sql);
      if (rejected) {
        return { ok: false, problems: [codeProblem('raw-query-rejected', rejected)] };
      }
      const rowLimit = Math.max(
        1,
        Math.min(RAW_QUERY_MAX_ROWS, argOptNumber(args, 'max_rows') ?? RAW_QUERY_DEFAULT_ROWS),
      );
      try {
        const res = await host.runSQL(argOptString(args, 'model_ref'), sql, rowLimit);
        const rows = res.rows.slice(0, rowLimit);
        const out: Record<string, unknown> = { ok: true, row_count: rows.length, rows };
        if ((res.total_rows ?? res.rows.length) > rows.length) {
          out.truncated = { row_limit: rowLimit, note: 'increase max_rows or aggregate in SQL' };
        }
        return out;
      } catch (e) {
        // Database errors verbatim — the error text is how an agent self-corrects.
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, problems: [codeProblem('raw-query-error', msg)] };
      }
    },
  };
}
