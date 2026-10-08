// describe_source as the explore tool serves it: the root source in full plus
// its join HIERARCHY (paths, no fields), and the fields at one path on request.
// By path rather than by the joined source's name, because a join can refine
// what it joins — path_extend.malloy's `crew.people` has a field `people` lacks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, describeSourceOutline, describeSourcePath, type ModelInfo } from '../src/index';
import { fixtureFiles, fixtureUrl, withFixtureRuntime } from './helpers';

const files = fixtureFiles();
const readSource = (href: string) => files.get(href);

async function model(entry: string): Promise<ModelInfo> {
  const result = await withFixtureRuntime((rt) => compile(rt, fixtureUrl(entry), { readSource }));
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  return result.model!;
}

test('the root lists every join path, and no join fields', async () => {
  const m = await model('path_extend.malloy');
  const d = describeSourceOutline(m, 'movies')!;
  assert.ok('movie_count' in d.described_source.measures, 'the root source is described in full');
  assert.deepEqual(Object.keys(d.joins), ['tags', 'crew', 'crew.people', 'crew.plain']);
  // Names and behaviour only: nothing in the hierarchy carries fields.
  for (const o of Object.values(d.joins)) {
    assert.ok(!('source_def' in o) && !('dimensions' in o), 'no fields in the hierarchy');
  }
  assert.equal(d.joins['crew']!.fans_out, true);
  assert.equal(d.joins['crew.people']!.fans_out, true, 'fan-out is for the whole path from the root');
  assert.equal(d.joins['tags']!.is_array, true);
  assert.match(d.joins['crew']!.code ?? '', /^join_many: crew/, 'a direct join carries its statement');
  assert.equal(d.joins['crew.people']!.code, undefined, 'deeper paths are names only');
  assert.equal(d.joins['crew.plain']!.source, 'people', 'an unmodified reference names its source');
  assert.equal(d.joins['crew.plain']!.description, 'A person.');
});

test('a path holds what the join made of its target, not the named source', async () => {
  const m = await model('path_extend.malloy');
  const at = describeSourcePath(m, 'movies', 'crew.people');
  assert.ok(at && at.ok);
  assert.ok('shout' in at.described_path.dimensions, 'the refinement is there');
  assert.match(at.described_path.code ?? '', /join_one: people is people extend/, 'and the statement that made it');
  assert.equal(at.described_path.source, undefined, 'a refined join names no source');
  // …and the top-level `people` really does lack it, which is the point.
  const people = describeSourceOutline(m, 'people')!;
  assert.ok(!('shout' in people.described_source.dimensions));
});

test('an unmodified reference describes as its source; the subtree comes with it', async () => {
  const m = await model('path_extend.malloy');
  const plain = describeSourcePath(m, 'movies', 'crew.plain');
  assert.ok(plain && plain.ok);
  assert.deepEqual(Object.keys(plain.described_path.dimensions).sort(), ['id', 'name']);
  assert.equal(plain.described_path.primary_key, 'id');

  const crew = describeSourcePath(m, 'movies', 'crew');
  assert.ok(crew && crew.ok);
  assert.deepEqual(Object.keys(crew.joins), ['crew.people', 'crew.plain'], 'joins below the path, by absolute path');
  assert.ok(!('views' in crew.described_path), 'no views through a path');
});

test('an array path describes its element', async () => {
  const m = await model('path_extend.malloy');
  const tags = describeSourcePath(m, 'movies', 'tags');
  assert.ok(tags && tags.ok);
  assert.deepEqual(Object.keys(tags.described_path.dimensions), ['each']);
});

test('an unknown path lists the ones there are', async () => {
  const m = await model('path_extend.malloy');
  const r = describeSourcePath(m, 'movies', 'crew.nope');
  assert.ok(r && !r.ok);
  assert.deepEqual(r.paths, ['tags', 'crew', 'crew.people', 'crew.plain']);
  assert.equal(describeSourcePath(m, 'nope', 'crew'), undefined, 'no such source');
});
