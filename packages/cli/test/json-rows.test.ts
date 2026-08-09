// Drift guard for the frame runtime's copy of jsonRows.
//
// `dashboard bundle` ships the frame source set (shared/, frame-runtime/, the
// entries) as SOURCE inside dist/ and re-bundles it on the user's machine
// against their model repo, so it cannot import a workspace package — which is
// why src/shared/json-rows.ts is a hand copy of mcp-engine/src/rows.ts rather
// than an import. This test runs both over the same real result and fails the
// moment they disagree, so a static site can never serialize rows differently
// from the server (malloyyo#137).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SingleConnectionRuntime } from '@malloydata/malloy';
import { DuckDBConnection } from '@malloydata/db-duckdb';
import { jsonRows as engineJsonRows } from '@malloyyo/mcp-engine';
import { jsonRows as frameJsonRows } from '../src/shared/json-rows.js';

// Same column set as the engine's bigints fixture: safe/unsafe bigints on both
// signs, a real string that must not be coerced, a date, and a nest.
const QUERY = `
source: nums is duckdb.sql("""
  SELECT 1::BIGINT                  as big,
         2::INTEGER                 as small,
         3.5::DOUBLE                as dbl,
         '42'                       as strcol,
         9007199254740993::BIGINT   as huge,
         -9007199254740993::BIGINT  as neg_huge,
         DATE '2020-01-02'          as d
""") extend {
  measure: big_total is big.sum()
}

run: nums -> {
  group_by: big, small, dbl, strcol, huge, neg_huge, d
  aggregate: big_total
  nest: sub is { group_by: big }
}
`;

test('frame jsonRows matches the engine jsonRows byte for byte', async () => {
  const connection = new DuckDBConnection({ name: 'duckdb' });
  try {
    const runtime = new SingleConnectionRuntime({ connection });
    const result = await runtime.loadQuery(QUERY).run();

    const fromEngine = engineJsonRows(result);
    const fromFrame = frameJsonRows(result);

    assert.deepEqual(fromFrame, fromEngine);
    // Pin the behaviour itself too, so the pair can't drift together into
    // something wrong and still agree.
    assert.equal(fromFrame[0]!['big'], 1, 'safe bigint narrowed to a number');
    assert.equal(fromFrame[0]!['huge'], '9007199254740993', 'unsafe bigint kept exact');
    assert.equal(fromFrame[0]!['strcol'], '42', 'string column untouched');
  } finally {
    await connection.close();
  }
});
