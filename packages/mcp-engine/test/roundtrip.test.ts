// Round-trip: build references from the describe_source OUTPUT (using the
// documented consumer rules — `quoted_path ?? key`, source_def field names,
// join_source_map fields) and prove they actually compile + execute. The shape
// tests in describe.test.ts assert structure; these assert the structure is
// *runnable* — the guard that catches "we emit a reference Malloy won't accept"
// (e.g. a wrong scalar-array accessor), which a shape test can't see.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, buildSourceDescribe, runRestricted, type ExploreSourceDescribe } from '../src/index';
import { fixtureUrl, withFixtureRuntime, fixtureFiles } from './helpers';

const files = fixtureFiles();
const readSource = (href: string) => files.get(href);

async function describe(entry: string, source: string): Promise<ExploreSourceDescribe> {
  const r = await withFixtureRuntime((rt) => compile(rt, fixtureUrl(entry), { readSource }));
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  const d = buildSourceDescribe(r.model!, source);
  assert.ok(d);
  return d!;
}
async function exec(entry: string, malloy: string) {
  const res = await withFixtureRuntime((rt) => runRestricted(rt, fixtureUrl(entry), malloy, { rowLimit: 50 }));
  assert.equal(res.ok, true, `did not execute: ${malloy}\n${JSON.stringify(res.problems)}`);
}
/** The documented rule for writing a join reference: quoted_path if present, else the key. */
const pathRef = (d: ExploreSourceDescribe, key: string): string => d.joins[key]?.quoted_path ?? key;
const firstKey = (o: object): string => Object.keys(o)[0]!;

test('round-trip: scalar array (each), record array (field), named join (field) all execute', async () => {
  const d = await describe('flights.malloy', 'flights');

  // scalar array → <path>.each
  assert.equal(d.joins['tags']?.is_array, true);
  await exec('flights.malloy', `run: flights -> { group_by: t is ${pathRef(d, 'tags')}.each }`);

  // record array → <path>.<field> (a field taken from its own source_def)
  const legField = firstKey(d.joins['legs']!.source_def!.dimensions);
  await exec('flights.malloy', `run: flights -> { group_by: x is ${pathRef(d, 'legs')}.${legField} }`);

  // named join → <path>.<field> (a dimension from join_source_map)
  const carrierDim = firstKey(d.join_source_map['carriers']!.dimensions);
  await exec('flights.malloy', `run: flights -> { group_by: c is ${pathRef(d, 'carriers')}.${carrierDim} }`);
});

test('round-trip: a measure reached through a named join executes', async () => {
  const d = await describe('tree.malloy', 'tapp');
  const teamMeasure = firstKey(d.join_source_map['tteams']!.measures); // team_count
  await exec('tree.malloy', `run: tapp -> { aggregate: m is ${pathRef(d, 'team')}.${teamMeasure} }`);
});

test('round-trip: quoted_path references (reserved segments) execute', async () => {
  const d = await describe('quote.malloy', 'quote_src');
  // top-level reserved scalar array `year`, and nested reserved rec.`year`.
  assert.equal(d.joins['year']?.quoted_path, '`year`');
  assert.equal(d.joins['rec.year']?.quoted_path, 'rec.`year`');
  await exec('quote.malloy', `run: quote_src -> { group_by: y is ${pathRef(d, 'year')}.each }`);
  await exec('quote.malloy', `run: quote_src -> { group_by: y is ${pathRef(d, 'rec.year')}.each }`);
});
