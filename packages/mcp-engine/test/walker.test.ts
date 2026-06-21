// Golden-file tests for the walker — the long pole everything downstream
// trusts. Run with UPDATE_GOLDENS=1 to refreeze after an intentional change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compile,
  listRuns,
  projectModel,
  selectSource,
  projectDescription,
  type SourceInfo,
} from '../src/index';
import {
  checkGolden,
  fixtureFiles,
  fixtureUrl,
  withFixtureRuntime,
} from './helpers';

const files = fixtureFiles();
const readSource = (href: string) => files.get(href);

test('flights: full develop shape (golden)', async () => {
  const result = await withFixtureRuntime((rt) =>
    compile(rt, fixtureUrl('flights.malloy'), { readSource }),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
  const { expected, actual } = checkGolden('flights.develop.json', result.model);
  assert.equal(actual, expected);
});

test('flights: explore projection (golden) strips develop-only fields', async () => {
  const result = await withFixtureRuntime((rt) =>
    compile(rt, fixtureUrl('flights.malloy'), { readSource }),
  );
  assert.ok(result.model);
  const projected = projectModel(result.model, 'explore');
  const { expected, actual } = checkGolden('flights.explore.json', projected);
  assert.equal(actual, expected);
  const text = JSON.stringify(projected);
  assert.ok(!text.includes('"location"'), 'no locations in explore shape');
  assert.ok(!text.includes('"body"'), 'no raw source text in the explore JSON (it rides as a separate block)');
  assert.ok(!text.includes('"entry"'), 'no entry in explore shape');
  assert.deepEqual(projected.runs, [], 'runs are not addressable on the explore surface');
  assert.equal(projected.queries.length, 1, 'named queries survive projection');
});

test('flights: source closure selection (golden)', async () => {
  const result = await withFixtureRuntime((rt) =>
    compile(rt, fixtureUrl('flights.malloy'), { readSource }),
  );
  assert.ok(result.model);
  const closure = selectSource(result.model, 'flights');
  assert.ok(closure);
  // flights joins carriers by ref → closure carries both, described once.
  assert.deepEqual(Object.keys(closure.sources).sort(), ['carriers', 'flights']);
  const explore = projectDescription(closure, 'explore');
  const { expected, actual } = checkGolden('flights.closure.explore.json', explore);
  assert.equal(actual, expected);
});

test('flights: every join carries source_ref and/or inline fields', async () => {
  const result = await withFixtureRuntime((rt) =>
    compile(rt, fixtureUrl('flights.malloy'), { readSource }),
  );
  const flights = result.model?.sources['flights'];
  assert.ok(flights);
  for (const j of flights.joins) {
    assert.ok(j.source_ref || j.fields, `join ${j.name} must have ref or fields`);
  }
  const legs = flights.joins.find((j) => j.name === 'legs');
  assert.ok(legs?.fields, 'repeated record join inlines fields');
  assert.equal(legs.relationship, 'one_to_many');
  const tags = flights.joins.find((j) => j.name === 'tags');
  assert.ok(tags?.fields, 'scalar array join inlines fields');
  assert.ok(
    !tags.fields.dimensions.some((f) => f.name === 'value'),
    'scalar array synthetic value column is stripped',
  );
  const carriers = flights.joins.find((j) => j.name === 'carriers');
  assert.equal(carriers?.source_ref, 'carriers');
  assert.equal(carriers?.fields, undefined, 'named join renders by ref');
});

test('flights: expand inline forces fields on named joins', async () => {
  const result = await withFixtureRuntime((rt) =>
    compile(rt, fixtureUrl('flights.malloy'), { readSource, expand: 'inline' }),
  );
  const carriers = result.model?.sources['flights']?.joins.find(
    (j) => j.name === 'carriers',
  );
  assert.equal(carriers?.source_ref, 'carriers');
  assert.ok(carriers?.fields, 'inline expand populates fields alongside ref');
});

test('flights: measures carry their defining expression', async () => {
  const result = await withFixtureRuntime((rt) =>
    compile(rt, fixtureUrl('flights.malloy'), { readSource }),
  );
  const m = result.model?.sources['flights']?.measures.find(
    (x) => x.name === 'total_distance',
  );
  assert.equal(m?.expression, 'distance.sum()');
});

test('multi-file model: full namespace described, locality via location', async () => {
  const result = await withFixtureRuntime((rt) =>
    compile(rt, fixtureUrl('index.malloy'), { readSource }),
  );
  assert.equal(result.ok, true);
  const model = result.model;
  assert.ok(model);
  assert.deepEqual(Object.keys(model.sources).sort(), ['managers', 'people']);
  assert.ok(!model.sources['people']?.location, 'imported source: no location');
  assert.ok(model.sources['managers']?.location, 'local source: has location');
  // Source TEXT crosses the import boundary (sliced from the imported file);
  // the location COORD does not. This is the location-slicing contract.
  const importedView = model.sources['people']?.views[0];
  assert.match(importedView?.body ?? '', /group_by: role/, 'imported view body sliced from its own file');
  assert.ok(!importedView?.location, 'imported view: no develop-only coord');
});

test('transitive import: un-nameable join targets become deduped anon_srcs', async () => {
  // tx_index imports tx_mid imports tx_bottom. Loaded from tx_index, tx_flights'
  // joins to tx_carriers (defined in tx_bottom) cannot be named here — Malloy's
  // referencedSource() is undefined while referenceSourceID is set. Both joins
  // point at the SAME bottom source → one anon_srcs entry, shared index.
  const result = await withFixtureRuntime((rt) =>
    compile(rt, fixtureUrl('tx_index.malloy'), { readSource }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  const flights = result.model?.sources['tx_flights'];
  assert.ok(flights, 'tx_flights is in the namespace (via import)');
  const carriers = flights.joins.find((j) => j.name === 'carriers');
  const alt = flights.joins.find((j) => j.name === 'alt');
  assert.equal(carriers?.source_ref, undefined, 'un-nameable: no source_ref');
  assert.equal(carriers?.fields, undefined, 'un-nameable: not inlined either');
  assert.equal(carriers?.anon_src_index, 0, 'first un-nameable target → index 0');
  assert.equal(alt?.anon_src_index, 0, 'second join to the SAME source → same index (deduped)');
  assert.equal(flights.anon_srcs?.length, 1, 'one anon source, not two');
  assert.equal(flights.anon_srcs?.[0]?.name, 'tx_carriers', 'label derived from the reference id');
  assert.ok(
    flights.anon_srcs?.[0]?.measures.some((m) => m.name === 'tx_carrier_count'),
    'the anon source carries its own fields',
  );
});

test('transitive import: explore projection of an anon closure (golden)', async () => {
  const result = await withFixtureRuntime((rt) =>
    compile(rt, fixtureUrl('tx_index.malloy'), { readSource }),
  );
  assert.ok(result.model);
  const closure = selectSource(result.model, 'tx_flights');
  assert.ok(closure);
  // tx_carriers is un-nameable, so it does NOT enter the model-sources closure;
  // it rides inside tx_flights.anon_srcs.
  assert.deepEqual(Object.keys(closure.sources), ['tx_flights']);
  const explore = projectDescription(closure, 'explore');
  const text = JSON.stringify(explore);
  assert.ok(!text.includes('"location"'), 'no develop-only coords in anon sources');
  assert.ok(!text.includes('"body"'), 'no raw body in the explore JSON');
  const { expected, actual } = checkGolden('tx_flights.closure.explore.json', explore);
  assert.equal(actual, expected);
});

test('explore projection: reserved member names are safe own data keys', () => {
  // The child collections are keyed by member NAME, and a Malloy identifier can
  // be `constructor` / `__proto__` / `hasOwnProperty` — names that, on a normal
  // object, would either mutate the prototype or collide with an inherited
  // method. byName builds the map on a null-prototype object so each lands as an
  // ordinary own data key.
  const src: SourceInfo = {
    name: 'weird',
    primary_key: null,
    dimensions: [
      { name: '__proto__', type: 'string' },
      { name: 'constructor', type: 'number' },
      { name: 'hasOwnProperty', type: 'boolean' },
    ],
    measures: [],
    views: [],
    joins: [],
  };
  const projected = projectDescription({ requested: 'weird', sources: { weird: src } }, 'explore');
  const dims = projected.sources['weird']!.dimensions;
  assert.deepEqual(
    Object.keys(dims).sort(),
    ['__proto__', 'constructor', 'hasOwnProperty'],
    'every reserved name is an own enumerable key',
  );
  assert.equal(dims['__proto__']!.type, 'string', '__proto__ is data, not the prototype');
  assert.equal(dims['constructor']!.type, 'number', 'constructor is data, not Object.constructor');
  assert.equal(dims['hasOwnProperty']!.type, 'boolean');
  // …and survives the JSON round-trip that is the actual wire form.
  const round = JSON.parse(JSON.stringify(dims));
  assert.equal(round['__proto__'].type, 'string', '__proto__ round-trips as data');
  assert.equal(round['constructor'].type, 'number');
});

test('must_quote: reserved-word and funny-character field names are flagged', async () => {
  const result = await withFixtureRuntime((rt) =>
    compile(rt, fixtureUrl('quoting.malloy'), { readSource }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  const dims = result.model!.sources['q']!.dimensions;
  const flag = (n: string) => dims.find((d) => d.name === n)?.must_quote;
  assert.equal(flag('year'), true, 'reserved word → must_quote');
  assert.equal(flag('space name'), true, 'funny characters → must_quote');
  assert.equal(flag('normal'), undefined, 'plain identifier → no flag');
  const total = result.model!.sources['q']!.measures.find((m) => m.name === 'total');
  assert.equal(total?.must_quote, undefined, 'plain measure → no flag');
});

test('exportedOnly: only exported sources are top-level (explore surface)', async () => {
  // index.malloy imports `people` (private) and defines `managers` (public,
  // exported by default). Develop sees both; the explore surface (exportedOnly)
  // sees only the exported `managers`.
  const { all, exported } = await withFixtureRuntime(async (rt) => ({
    all: await compile(rt, fixtureUrl('index.malloy'), { readSource }),
    exported: await compile(rt, fixtureUrl('index.malloy'), { exportedOnly: true }),
  }));
  assert.deepEqual(Object.keys(all.model!.sources).sort(), ['managers', 'people']);
  assert.deepEqual(Object.keys(exported.model!.sources).sort(), ['managers']);
});

test('givens model: declarations at model scope (golden)', async () => {
  const result = await withFixtureRuntime((rt) =>
    compile(rt, fixtureUrl('givens_model.malloy'), { readSource }),
  );
  assert.equal(result.ok, true);
  const { expected, actual } = checkGolden('givens.develop.json', result.model);
  assert.equal(actual, expected);
  assert.equal(result.model?.givens?.[0]?.name, 'TARGET');
  assert.equal(result.model?.givens?.[0]?.has_default, true);
  assert.deepEqual(result.model?.queries[0]?.givens, ['TARGET']);
});

test('compile failure: problems with positions, no model', async () => {
  const result = await withFixtureRuntime((rt) =>
    compile(rt, fixtureUrl('broken.malloy')),
  );
  assert.equal(result.ok, false);
  assert.equal(result.model, undefined);
  assert.ok(result.problems.length > 0);
  assert.equal(result.problems[0]?.severity, 'error');
});

test('field-not-found problems carry a help_topic', async () => {
  const result = await withFixtureRuntime((rt) =>
    compile(rt, fixtureUrl('bad_field.malloy')),
  );
  assert.equal(result.ok, false);
  const p = result.problems.find((x) => x.code === 'field-not-found');
  assert.ok(p, 'expected a field-not-found problem');
  assert.equal(p.help_topic, 'language/fields');
  assert.equal(typeof p.line, 'number');
});

test('CRLF line endings: model compiles and describes intact', async () => {
  // Regression mirrored from malloy-cli: a model saved with CRLF endings
  // must compile and describe like its LF twin.
  const crlf = files.get('file:///fixture/flights.malloy')!.replace(/\n/g, '\r\n');
  const crlfFiles = new Map(files);
  crlfFiles.set('file:///fixture/crlf.malloy', crlf);
  const { mapReader, makeRuntime } = await import('./helpers');
  const { runtime, close } = makeRuntime(mapReader(crlfFiles));
  try {
    const result = await compile(runtime, new URL('file:///fixture/crlf.malloy'), {
      readSource: (h) => crlfFiles.get(h),
    });
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.deepEqual(Object.keys(result.model!.sources).sort(), ['carriers', 'flights']);
    assert.equal(result.model?.queries[0]?.name, 'top_carriers');
  } finally {
    await close();
  }
});

test('formatted flag: canonical-form signal without echoing text', async () => {
  const { mapReader, makeRuntime } = await import('./helpers');
  const { prettify } = await import('../src/index');
  // A canonically-formatted twin of the flights model → formatted: true.
  const canonical = prettify(files.get('file:///fixture/flights.malloy')!).formatted;
  const aug = new Map(files);
  aug.set('file:///fixture/canonical.malloy', canonical);
  const { runtime, close } = makeRuntime(mapReader(aug));
  try {
    const pretty = await compile(runtime, new URL('file:///fixture/canonical.malloy'), {
      readSource: (h) => aug.get(h),
    });
    assert.equal(pretty.ok, true, JSON.stringify(pretty.problems));
    assert.equal(pretty.formatted, true);

    // Mangle whitespace → still compiles, but formatted: false.
    aug.set('file:///fixture/mangled.malloy', canonical.replace(/\n/g, '\n\n'));
    const mangled = await compile(runtime, new URL('file:///fixture/mangled.malloy'), {
      readSource: (h) => aug.get(h),
    });
    assert.equal(mangled.ok, true);
    assert.equal(mangled.formatted, false);

    // No readSource (explore-bound) → flag omitted entirely.
    const blind = await compile(runtime, new URL('file:///fixture/canonical.malloy'));
    assert.equal(blind.formatted, undefined);
  } finally {
    await close();
  }
});

test('listRuns: cheap discovery without serialization', async () => {
  const listing = await withFixtureRuntime((rt) =>
    listRuns(rt, fixtureUrl('flights.malloy')),
  );
  assert.equal(listing.ok, true);
  assert.equal(listing.runs.length, 2);
  assert.deepEqual(listing.queries.map((q) => q.name), ['top_carriers']);
});

test('emit_run_sql: opt-in SQL on run statements', async () => {
  const result = await withFixtureRuntime((rt) =>
    compile(rt, fixtureUrl('flights.malloy'), { emitRunSql: true }),
  );
  assert.ok(result.model?.runs[0]?.sql?.toLowerCase().includes('select'));
  const noSql = await withFixtureRuntime((rt) =>
    compile(rt, fixtureUrl('flights.malloy')),
  );
  assert.equal(noSql.model?.runs[0]?.sql, undefined);
});
