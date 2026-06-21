// describe_source structured shape (explore), v5: columns (scalars + single
// records inline, arrays as dimension stubs) vs the flat `joins` list (arrays +
// source-joins). Exercises every column/join kind, dedup, the views law, the
// anonymous wrinkle, and the cycle guard. Run with UPDATE_GOLDENS=1 to refreeze.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compile, buildSourceDescribe,
  type ModelInfo, type SourceInfo, type JoinInfo, type ArrayStub, type CompactField,
} from '../src/index';
import { checkGolden, fixtureFiles, fixtureUrl, withFixtureRuntime } from './helpers';

const files = fixtureFiles();
const readSource = (href: string) => files.get(href);

async function describe(entry: string, source: string) {
  const result = await withFixtureRuntime((rt) => compile(rt, fixtureUrl(entry), { readSource }));
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  const d = buildSourceDescribe(result.model!, source);
  assert.ok(d, `buildSourceDescribe(${source}) returned undefined`);
  return d!;
}
const entry = (d: { joins: Record<string, import('../src/index').JoinEntry> }, path: string) =>
  d.joins[path];

// ── tree.malloy: depth-2 named chain, a source joined twice, a record array ──

test('tree: golden', async () => {
  const d = await describe('tree.malloy', 'tapp');
  const { expected, actual } = checkGolden('tree.describe.explore.json', d);
  assert.equal(actual, expected);
});

test('tree: columns vs joins — record array is a dimension stub AND a joins entry', async () => {
  const d = await describe('tree.malloy', 'tapp');
  // scalars are dimensions; the record array `goals` is a STUB in dimensions…
  assert.equal((d.described_source.dimensions['tid'] as CompactField).type, 'string');
  const stub = d.described_source.dimensions['goals'] as ArrayStub;
  assert.equal(stub.is_array, true);
  assert.equal(stub.fans_out, true, 'array stubs carry fans_out — the total cardinality signal');
  assert.equal(stub.path, 'goals');
  assert.ok(!('type' in stub), 'an array stub has no `type`');
  // …with its detail (element fields) in the flat joins list.
  const goals = entry(d, 'goals')!;
  assert.equal(goals.is_array, true);
  assert.equal(goals.fans_out, true, 'the array joins entry also carries fans_out');
  assert.equal((goals.source_def!.dimensions['scorer'] as CompactField).type, 'string');
  // source-joins are NOT columns: `team` is not in dimensions.
  assert.ok(!('team' in d.described_source.dimensions), 'a source-join is never a dimension');
});

test('tree: dedup, depth-2 references, fan, views-only-on-root', async () => {
  const d = await describe('tree.malloy', 'tapp');
  // team + opponent → two entries onto one source; tteams appears once in the map.
  assert.equal(entry(d, 'team')!.source, 'tteams');
  assert.equal(entry(d, 'opponent')!.source, 'tteams');
  assert.deepEqual(Object.keys(d.join_source_map).sort(), ['tconf', 'tteams']);
  // depth-2 named refs, both paths present; tconf deduped despite two paths.
  assert.equal(entry(d, 'team.confederation')!.source, 'tconf');
  assert.equal(entry(d, 'opponent.confederation')!.source, 'tconf');
  // a join_one source-join has no fans_out; the array fans (fans_out present).
  assert.equal(entry(d, 'team')!.fans_out, undefined);
  assert.equal(entry(d, 'team')!.is_array, undefined);
  assert.equal(entry(d, 'goals')!.is_array, true);
  assert.equal(entry(d, 'goals')!.fans_out, true);
  // views live only on the described source; never in a joined source.
  assert.ok('by_team' in d.described_source.views);
  for (const s of Object.values(d.join_source_map)) assert.ok(!('views' in s));
});

// ── flights.malloy: scalar array (each) + record array + named join ──

test('flights: scalar array uses `each`, record array uses real fields', async () => {
  const d = await describe('flights.malloy', 'flights');
  const tags = entry(d, 'tags')!;        // scalar array
  assert.equal(tags.is_array, true);
  assert.equal(tags.fans_out, true);
  assert.deepEqual(Object.keys(tags.source_def!.dimensions), ['each']);
  assert.equal((tags.source_def!.dimensions['each'] as CompactField).type, 'string');
  const legs = entry(d, 'legs')!;        // record array
  assert.equal(legs.is_array, true);
  assert.equal(legs.fans_out, true);
  assert.deepEqual(Object.keys(legs.source_def!.dimensions).sort(), ['n', 'tag']);
  // named join carries code with the restored keyword.
  assert.match(entry(d, 'carriers')!.code ?? '', /^join_one: carriers is carriers/);
});

// ── wrinkle: an anonymous source whose onward join targets a NAMED source ──

test('wrinkle: golden', async () => {
  const d = await describe('wrinkle_top.malloy', 'wflights');
  const { expected, actual } = checkGolden('wrinkle.describe.explore.json', d);
  assert.equal(actual, expected);
});

test('wrinkle: anonymous source_def, named descendant compressed to a reference', async () => {
  const d = await describe('wrinkle_top.malloy', 'wflights');
  const carriers = entry(d, 'carriers')!;     // un-nameable here → inline source_def
  assert.ok(carriers.source_def, 'anonymous source inlines its schema');
  assert.ok(!carriers.source, 'no named source');
  // its onward join to a NAMED source is a reference, added to the map.
  const region = entry(d, 'carriers.region')!;
  assert.equal(region.source, 'regions');
  assert.ok(!region.source_def, 'named descendant is not re-inlined');
  assert.ok('regions' in d.join_source_map);
});

// ── an array column inside a NAMED (deduped) joined source ──

test('map stub: array in a named join is a relative stub in the map, absolute in joins', async () => {
  const d = await describe('mapstub.malloy', 'holder');
  // The named source `labeled` has a scalar-array column `labels`.
  const map = d.join_source_map['labeled']!;
  const stub = map.dimensions['labels'] as ArrayStub;
  assert.equal(stub.is_array, true);
  assert.equal(stub.fans_out, true, 'relative map stubs still carry fans_out');
  assert.equal(stub.path, undefined, 'deduped map stubs are relative (no absolute path)');
  // …and the absolute entry lives in the flat joins list under the handle.
  const arr = entry(d, 'lab.labels')!;
  assert.equal(arr.is_array, true);
  assert.equal(arr.fans_out, true);
  assert.deepEqual(Object.keys(arr.source_def!.dimensions), ['each']);
});

// ── quoting: a reserved path segment → clean key + quoted_path ──

test('quoting: joins keys stay clean; quoted_path appears only when a segment needs it', async () => {
  const d = await describe('quote.malloy', 'quote_src');
  // top-level reserved array `year`: clean key, paste-ready quoted_path.
  assert.ok('year' in d.joins, 'key is the clean (bare) name');
  assert.equal(d.joins['year']!.quoted_path, '`year`');
  // its dimension stub points at the clean key, and flags its own name.
  const stub = d.described_source.dimensions['year'] as ArrayStub;
  assert.equal(stub.path, 'year');
  assert.equal(stub.must_quote, true);
  // nested reserved array `rec.year`: clean key, quoted_path quotes only the bad segment.
  assert.ok('rec.year' in d.joins, 'nested key is clean dotted');
  assert.equal(d.joins['rec.year']!.quoted_path, 'rec.`year`');
});

// ── cycle guard (hand-built model — real cyclic joins are awkward in Malloy) ──

const src = (name: string, joins: JoinInfo[]): SourceInfo => ({
  name, primary_key: null, dimensions: [], measures: [], views: [], joins,
});
const namedJoin = (name: string, ref: string): JoinInfo => ({
  name, relationship: 'many_to_one', source_ref: ref,
});
const manyJoin = (name: string, ref: string): JoinInfo => ({
  name, relationship: 'one_to_many', source_ref: ref,
});

test('fans: join_many fans, and it propagates to a join_one descendant', () => {
  // a -[join_many]-> b -[join_one]-> c
  const model: ModelInfo = {
    sources: {
      a: src('a', [manyJoin('to_b', 'b')]),
      b: src('b', [namedJoin('to_c', 'c')]),
      c: src('c', []),
    },
    queries: [], runs: [],
  };
  const d = buildSourceDescribe(model, 'a')!;
  assert.equal(entry(d, 'to_b')!.fans_out, true, 'join_many fans');
  assert.equal(entry(d, 'to_b.to_c')!.fans_out, true, 'join_one under a fanning ancestor still fans');
});

test('guard: a named cycle is marked and not descended', () => {
  const model: ModelInfo = {
    sources: { a: src('a', [namedJoin('to_b', 'b')]), b: src('b', [namedJoin('to_a', 'a')]) },
    queries: [], runs: [],
  };
  const d = buildSourceDescribe(model, 'a')!;
  const toA = entry(d, 'to_b.to_a')!;
  assert.equal(toA.source, 'a');
  assert.equal(toA.cycle, true, 'revisiting a source on the path is a cycle');
  // no entries descend past the cycle.
  assert.ok(!Object.keys(d.joins).some((p) => p.startsWith('to_b.to_a.')), 'cycle is not descended');
});
