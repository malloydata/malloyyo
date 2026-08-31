// Access modifiers: what each surface does with a field the model marked
// `private` or `internal`.
//
// The rule the surfaces split on: a QUERY compiles against a source at access
// level 'public', and 'internal' only opens up to a source that EXTENDS or
// JOINS the one declaring it — so neither modifier can be referenced from
// query text. Explore (describe_source, the explore projection) therefore drops
// those members outright; develop keeps them and labels them, because an author
// editing the model needs to see what is hidden.
//
// The last test is what keeps this honest: it runs the queries, so "explore
// hides exactly the unqueryable" is proven rather than asserted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compile, buildSourceDescribe, projectModel, runRestricted,
  type FieldInfo, type JoinInfo, type ModelInfo, type ViewInfo,
} from '../src/index';
import { fixtureFiles, fixtureUrl, withFixtureRuntime } from './helpers';

const files = fixtureFiles();
const readSource = (href: string) => files.get(href);

async function compiled(): Promise<ModelInfo> {
  const result = await withFixtureRuntime((rt) =>
    compile(rt, fixtureUrl('access.malloy'), { readSource }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  return result.model!;
}

async function describe(source: string) {
  const d = buildSourceDescribe(await compiled(), source);
  assert.ok(d, `buildSourceDescribe(${source}) returned undefined`);
  return d;
}

/** `name[modifier]` for each member, so one assert reads the whole group. */
const marked = (ms: (FieldInfo | ViewInfo | JoinInfo)[]): string =>
  ms.map((m) => (m.access ? `${m.name}[${m.access}]` : m.name)).join(', ');

// ── explore: the non-public members are gone ───────────────────────

test('explore: describe_source omits private and internal members', async () => {
  const d = await describe('acc_fields');
  assert.deepEqual(Object.keys(d.described_source.dimensions), ['n', 'label', 'note', 'shown_dim']);
  assert.deepEqual(Object.keys(d.described_source.measures), ['total', 'shown_measure']);
  assert.deepEqual(Object.keys(d.described_source.views), ['shown_view']);
});

test('explore: a private join is dropped whole', async () => {
  const d = await describe('acc_joins');
  assert.deepEqual(Object.keys(d.joins), ['shown_join']);
});

test('explore: join_source_map does not leak the target source’s private fields', async () => {
  const d = await describe('acc_fields');
  const parts = d.join_source_map['acc_parts'];
  assert.ok(parts, 'the joined source should be in join_source_map');
  assert.deepEqual(Object.keys(parts.dimensions), ['n', 'part', 'part_label']);
});

test('explore: an include block’s demotions are respected', async () => {
  const d = await describe('acc_included');
  assert.deepEqual(Object.keys(d.described_source.dimensions), ['n', 'label']);
  assert.deepEqual(Object.keys(d.described_source.measures), []);
});

test('explore: the projection drops them too', async () => {
  const m = projectModel(await compiled(), 'explore');
  const fields = m.sources['acc_fields']!;
  assert.deepEqual(Object.keys(fields.dimensions), ['n', 'label', 'note', 'shown_dim']);
  assert.deepEqual(Object.keys(fields.views), ['shown_view']);
  assert.deepEqual(Object.keys(m.sources['acc_joins']!.joins), ['shown_join']);
});

test('explore: a primary key that was demoted is not advertised', async () => {
  // The key names a field the filter removed — naming it anyway hands the
  // reader an identifier they cannot write.
  const d = await describe('acc_pk_hidden');
  assert.deepEqual(Object.keys(d.described_source.dimensions), ['tag']);
  assert.equal(d.described_source.primary_key, undefined);
  const kept = await describe('acc_pk');
  assert.equal(kept.described_source.primary_key, 'id', 'a public primary key still shows');
});

// ── develop: the author sees everything, with the marker ───────────

test('develop: keeps every member and labels its modifier', async () => {
  const m = await compiled();
  const s = m.sources['acc_fields']!;
  assert.equal(marked(s.dimensions), 'n, label, note, hidden_dim[private], staff_dim[internal], shown_dim');
  assert.equal(marked(s.measures), 'total, hidden_measure[private], staff_measure[internal], shown_measure');
  assert.equal(marked(s.views), 'hidden_view[private], shown_view');
  assert.equal(marked(m.sources['acc_joins']!.joins), 'hidden_join[private], shown_join');
  assert.equal(marked(m.sources['acc_parts']!.dimensions), 'n, part, part_secret[private], part_label');
});

test('develop: a public member carries no access key at all', async () => {
  const s = (await compiled()).sources['acc_fields']!;
  const shown = s.dimensions.find((f) => f.name === 'shown_dim')!;
  assert.equal('access' in shown, false, 'absent means public — not a "public" value');
});

// ── the two halves agree with the compiler ─────────────────────────

test('everything explore hides is unqueryable; everything it keeps runs', async () => {
  const run = (q: string) =>
    withFixtureRuntime((rt) => runRestricted(rt, fixtureUrl('access.malloy'), q, { rowLimit: 5 }));

  for (const q of [
    'run: acc_fields -> { group_by: hidden_dim }',
    'run: acc_fields -> { group_by: staff_dim }',
    'run: acc_fields -> { aggregate: hidden_measure }',
    'run: acc_fields -> hidden_view',
    'run: acc_fields -> { group_by: acc_parts.part_secret }',
    'run: acc_joins -> { group_by: hidden_join.part_label }',
    'run: acc_included -> { group_by: note }',
  ]) {
    const r = await run(q);
    assert.equal(r.ok, false, `should not have run: ${q}`);
  }

  const ok = await run(
    'run: acc_fields -> { group_by: shown_dim, acc_parts.part_label; aggregate: shown_measure }',
  );
  assert.equal(ok.ok, true, `the public members should still query: ${JSON.stringify(ok.problems)}`);
});
