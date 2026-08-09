// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Test plumbing: compile a real model WITH a driver (DuckDB, a devDependency
// here and only here) so the tests exercise a genuine ModelDef rather than a
// hand-written approximation of one. The client under test then opens it with
// no driver at all — which is the property worth testing.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SingleConnectionRuntime } from '@malloydata/malloy';
import { DuckDBConnection } from '@malloydata/db-duckdb';
import { encodeModelBlob, extractModelDef, type ModelBlob } from '@malloyyo/mcp-engine';

export const DEMO_MODEL = `
source: orders is duckdb.sql("""
  SELECT 1 as id, 'CA' as state, 10.5 as amount UNION ALL
  SELECT 2, 'NY', 20.0 UNION ALL
  SELECT 3, 'CA', 5.25
""") extend {
  #" Customer orders, one row per order.
  measure: order_count is count()
  measure: total_amount is amount.sum()
  #" Orders and revenue by state.
  view: by_state is { group_by: state; aggregate: order_count, total_amount }
}
`;

/** Compile Malloy source for real and wrap the result in a blob envelope. */
export async function makeBlob(
  source = DEMO_MODEL,
  opts: { model_ref?: string; client_version?: string } = {},
): Promise<ModelBlob> {
  const files = new Map([['file:///index.malloy', source]]);
  const connection = new DuckDBConnection({ name: 'duckdb' });
  try {
    const runtime = new SingleConnectionRuntime({
      connection,
      urlReader: {
        readURL: (u: URL) => {
          const text = files.get(u.href);
          return text === undefined
            ? Promise.reject(new Error(`not found: ${u.href}`))
            : Promise.resolve(text);
        },
      },
    });
    const model = await runtime.loadModel(new URL('file:///index.malloy')).getModel();
    return encodeModelBlob(extractModelDef(model), {
      model_ref: opts.model_ref ?? 'demo',
      client_version: opts.client_version ?? '0.0.0-test',
    });
  } finally {
    await connection.close();
  }
}

/** Write a blob to a scratch file and return its path. */
export async function blobFile(...args: Parameters<typeof makeBlob>): Promise<string> {
  const blob = await makeBlob(...args);
  const dir = mkdtempSync(path.join(tmpdir(), 'malloyyo-client-'));
  const file = path.join(dir, 'model.json');
  writeFileSync(file, JSON.stringify(blob));
  return file;
}
