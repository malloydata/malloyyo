// jsonRows — the wire shape of a Malloy result (malloyyo#137).
//
// Malloy's own toJSON() renders every `numberType: 'bigint'` as a decimal
// string no matter how small the value, which silently turns numeric columns
// lexicographic for anything downstream that just reads JSON. jsonRows fixes
// that class while changing nothing else, so these tests pin BOTH halves: the
// bigints that must now be numbers, and byte-for-byte parity with toJSON()
// everywhere else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonRows, run } from '../src/index';
import { fixtureUrl, withFixtureRuntime } from './helpers';

/** Run the fixture and hand back the one row, both ways. */
async function bothWays(): Promise<{
  fixed: Record<string, unknown>;
  legacy: Record<string, unknown>;
}> {
  return withFixtureRuntime(async (rt) => {
    const result = await rt.loadModel(fixtureUrl('bigints.malloy')).loadFinalQuery().run();
    return {
      fixed: jsonRows(result)[0]!,
      legacy: (result.toJSON().queryResult.result as Record<string, unknown>[])[0]!,
    };
  });
}

test('jsonRows: a BIGINT inside the safe range is a JSON number', async () => {
  const { fixed, legacy } = await bothWays();
  assert.equal(legacy['big'], '1', 'precondition: Malloy toJSON() stringifies it');
  assert.equal(fixed['big'], 1);
  assert.equal(typeof fixed['big'], 'number');
});

test('jsonRows: an aggregate over a BIGINT is a number too', async () => {
  const { fixed } = await bothWays();
  assert.equal(fixed['big_total'], 1);
  assert.equal(typeof fixed['big_total'], 'number');
});

test('jsonRows: values beyond MAX_SAFE_INTEGER stay exact strings', async () => {
  const { fixed } = await bothWays();
  // Deliberate: JSON has no int64, and Number('9007199254740993') would round
  // to …992. A string that loses nothing beats a number that lies.
  assert.equal(fixed['huge'], '9007199254740993');
  assert.equal(fixed['neg_huge'], '-9007199254740993');
});

test('jsonRows: a genuine string column is never coerced', async () => {
  const { fixed } = await bothWays();
  // The conversion is type-driven (the schema says bigint), never a guess about
  // what a string looks like — so "42" survives as "42".
  assert.equal(fixed['strcol'], '42');
  assert.equal(typeof fixed['strcol'], 'string');
});

test('jsonRows: recurses into nests', async () => {
  const { fixed } = await bothWays();
  const sub = fixed['sub'] as Record<string, unknown>[];
  assert.equal(sub[0]!['big'], 1);
  assert.equal(typeof sub[0]!['big'], 'number');
});

test('jsonRows: everything that is not a small bigint matches toJSON exactly', async () => {
  const { fixed, legacy } = await bothWays();
  // The only permitted difference is bigint-string -> number. Compare every
  // cell as text so a drift in date formatting, float rendering, or key order
  // fails here rather than in a dashboard six months from now.
  assert.deepEqual(Object.keys(fixed), Object.keys(legacy), 'same columns, same order');
  for (const key of Object.keys(legacy)) {
    assert.equal(
      JSON.stringify(fixed[key]).replaceAll('"', ''),
      JSON.stringify(legacy[key]).replaceAll('"', ''),
      `column ${key} differs beyond quoting`,
    );
  }
  assert.equal(legacy['d'], '2020-01-02T00:00:00.000Z', 'dates are ISO strings, unchanged');
});

test('run(): the fix reaches the RunResult wire shape', async () => {
  // executeMaterialized is the choke point every surface goes through —
  // hosted MCP query, the restricted path, dashboards, suggestions.
  const result = await withFixtureRuntime((rt) => run(rt, fixtureUrl('bigints.malloy')));
  assert.equal(result.ok, true);
  const row = (result.rows as Record<string, unknown>[])[0]!;
  assert.equal(row['big'], 1);
  assert.equal(typeof row['big'], 'number');
});
