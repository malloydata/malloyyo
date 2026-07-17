// Model-contributed guidance + the raw-query escape hatch: the mechanism a
// model repo uses to ship its own rules (guidance/**.md → yo_help topics) and,
// when it opts in, a guarded raw-SQL tool on its own connection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkSelectOnly,
  exploreSurface,
  guidanceInstructionsBlock,
  modelGuidanceTopics,
  rawQueryTool,
} from '../src/index';
import { testExploreHost } from './helpers';

const FILES: Array<[string, string]> = [
  ['index.malloy', 'source: x is duckdb.table("t")'],
  ['guidance/sales.md', '---\ndescription: Which sales column wins\n---\nUse pre-tax.'],
  ['guidance/deep/Category Rules.md', 'Two hierarchies exist.'],
  ['guidance/readme.txt', 'not markdown — ignored'],
  ['notes.md', 'outside guidance/ — ignored'],
];

test('modelGuidanceTopics: guidance/**.md only, path-named, front matter parsed', () => {
  const topics = modelGuidanceTopics(FILES);
  assert.deepEqual(
    topics.map((t) => t.name),
    ['guidance/deep/category-rules', 'guidance/sales'],
  );
  const sales = topics.find((t) => t.name === 'guidance/sales')!;
  assert.equal(sales.description, 'Which sales column wins');
  assert.equal(sales.body, 'Use pre-tax.');
});

test('modelGuidanceTopics: namespace prefixes every name', () => {
  const topics = modelGuidanceTopics(FILES, 'My Model');
  assert.ok(topics.every((t) => t.name.startsWith('my-model/guidance/')));
});

test('guidanceInstructionsBlock: one line per topic, empty for none', () => {
  assert.equal(guidanceInstructionsBlock([]), '');
  const block = guidanceInstructionsBlock(modelGuidanceTopics(FILES));
  assert.match(block, /`guidance\/sales` — Which sales column wins/);
  assert.match(block, /BEFORE writing a query/);
});

test('explore surface folds guidance into yo_help index, lookup, and instructions', async () => {
  const topics = modelGuidanceTopics(FILES, 'shop');
  const s = exploreSurface(testExploreHost(), { guidance: topics });
  assert.match(s.instructions, /shop\/guidance\/sales/);
  const yo = s.tools.find((t) => t.name === 'yo_help')!;
  const index = (await yo.handler({})) as { topics: string[] };
  assert.ok(index.topics.includes('shop/guidance/sales'));
  // Exact and substring (short-name) lookups both land.
  const exact = (await yo.handler({ topic: 'shop/guidance/sales' })) as { body: string };
  assert.equal(exact.body, 'Use pre-tax.');
  const short = (await yo.handler({ topic: 'guidance/sales' })) as { body: string };
  assert.equal(short.body, 'Use pre-tax.');
  // Engine topics still resolve.
  const engine = (await yo.handler({ topic: 'explore/how-to' })) as { name: string };
  assert.equal(engine.name, 'explore/how-to');
});

test('no guidance → surface unchanged (no lead block, plain yo_help description)', () => {
  const s = exploreSurface(testExploreHost());
  assert.doesNotMatch(s.instructions, /publishes its own guidance/);
  const yo = s.tools.find((t) => t.name === 'yo_help')!;
  assert.doesNotMatch(yo.description, /model also publishes/);
});

test('checkSelectOnly: accepts single read statements', () => {
  for (const sql of [
    'SELECT 1',
    'select * from t;',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    'FROM t SELECT 1',
    '-- comment\nSELECT 2',
    '/* block */ SELECT 3',
  ]) {
    assert.equal(checkSelectOnly(sql), undefined, sql);
  }
});

test('checkSelectOnly: rejects writes, multi-statements, hidden DDL', () => {
  assert.match(checkSelectOnly('')!, /Empty/);
  assert.match(checkSelectOnly('DROP TABLE t')!, /starts with 'drop'/);
  assert.match(checkSelectOnly('SELECT 1; SELECT 2')!, /one statement/);
  assert.match(checkSelectOnly('WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x')!, /'INSERT'|'insert'/i);
  assert.match(checkSelectOnly('SELECT 1 /* hi */; DROP TABLE t')!, /one statement/);
  assert.match(checkSelectOnly('-- DROP\nUPDATE t SET a=1')!, /starts with 'update'/);
  assert.match(checkSelectOnly("SELECT * FROM t WHERE note = 'please update me'")!, /rephrase/);
});

test('rawQueryTool: guards before the host, truncates honestly, surfaces DB errors', async () => {
  const calls: string[] = [];
  const tool = rawQueryTool({
    runSQL: async (_ref, sql, limit) => {
      calls.push(sql);
      return { rows: Array.from({ length: limit }, (_, i) => ({ i })), total_rows: 5000 };
    },
  });
  const rejected = (await tool.handler({ sql: 'DELETE FROM t' })) as { ok: boolean; problems: Array<{ code?: string }> };
  assert.equal(rejected.ok, false);
  assert.equal(calls.length, 0, 'guard fires before the host');

  const run = (await tool.handler({ sql: 'SELECT 1', max_rows: 7 })) as {
    ok: boolean; row_count: number; truncated?: object;
  };
  assert.equal(run.ok, true);
  assert.equal(run.row_count, 7);
  assert.ok(run.truncated, 'total_rows > returned → truncated flag');

  const failing = rawQueryTool({
    runSQL: async () => { throw new Error('Catalog Error: table nope does not exist'); },
  });
  const err = (await failing.handler({ sql: 'SELECT * FROM nope' })) as {
    ok: boolean; problems: Array<{ message: string }>;
  };
  assert.equal(err.ok, false);
  assert.match(err.problems[0]!.message, /Catalog Error/);
});
