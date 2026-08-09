// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The compiled-model blob: envelope validation, and the load-bearing claim that
// a blob compiled WITH a driver can be re-opened and queried WITHOUT one. That
// second half is the whole reason malloyyo_client can ship 50 packages instead
// of 661, so it is tested against a real compiled model, not a hand-built stub.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '@malloydata/malloy';
import {
  MODEL_BLOB_FORMAT,
  compile,
  decodeModelBlob,
  encodeModelBlob,
  extractModelDef,
  modelConnections,
  rehydrateModel,
  _blobMeta,
} from '../src/index';
import { fixtureUrl, withFixtureRuntime } from './helpers';

const ENCODE_OPTS = { model_ref: 'test', client_version: '9.9.9' };

// ── envelope ────────────────────────────────────────────────────────

test('encode → decode round-trips a ModelDef-shaped object', () => {
  const def = { name: 'm', exports: ['a', 'b'], nested: { xs: [1, 2, 3], s: 'hi', b: true, z: null } };
  const res = decodeModelBlob(encodeModelBlob(def, ENCODE_OPTS));
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.def, def);
  assert.equal(res.blob.model_ref, 'test');
  assert.equal(res.blob.client_version, '9.9.9');
});

test('decode accepts the envelope as a JSON string (the paste path)', () => {
  const def = { hello: 'world' };
  const res = decodeModelBlob(JSON.stringify(encodeModelBlob(def, ENCODE_OPTS)));
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.def, def);
});

test('encode compresses hard — repetitive ModelDef JSON must shrink by >10x', () => {
  // Shaped like a real ModelDef: many near-identical field records.
  const def = {
    contents: Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [
        `field_${i}`,
        { type: 'string', name: `field_${i}`, dialect: 'duckdb', connection: 'duckdb', location: { line: i } },
      ]),
    ),
  };
  const blob = encodeModelBlob(def, ENCODE_OPTS);
  assert.ok(
    blob.payload.length * 10 < blob.bytes,
    `expected >10x shrink, got ${blob.bytes} -> ${blob.payload.length}`,
  );
});

test('decode REJECTS a blob compiled by a different Malloy, and names the client to install', () => {
  const blob = { ...encodeModelBlob({ a: 1 }, ENCODE_OPTS), malloy_version: '0.0.0-other' };
  const res = decodeModelBlob(blob);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /0\.0\.0-other/);
  assert.match(res.error, new RegExp(_blobMeta.MALLOY_VERSION.replace(/\./g, '\\.')));
  // The actionable half: an out-of-date client must be told what to install.
  assert.match(res.error, /malloyyo-client@9\.9\.9/);
});

test('decode rejects a different envelope format', () => {
  const res = decodeModelBlob({ ...encodeModelBlob({ a: 1 }, ENCODE_OPTS), format: MODEL_BLOB_FORMAT + 99 });
  assert.equal(res.ok, false);
});

test('allowVersionMismatch opens a mismatched blob but never does so silently', () => {
  const blob = {
    ...encodeModelBlob({ a: 1 }, ENCODE_OPTS),
    malloy_version: '0.0.0-other',
    format: MODEL_BLOB_FORMAT + 99,
  };
  assert.equal(decodeModelBlob(blob).ok, false, 'must still refuse by default');

  const res = decodeModelBlob(blob, { allowVersionMismatch: true });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.def, { a: 1 });
  // Both gates report; a dev override that hid what it overrode would be worse
  // than the gate it replaces.
  assert.equal(res.warnings?.length, 2);
  assert.ok(res.warnings?.some((w) => /0\.0\.0-other/.test(w)));
  assert.ok(res.warnings?.some((w) => /format/.test(w)));
});

test('allowVersionMismatch does NOT weaken the checksum or the encoding check', () => {
  // The override is about versions, not integrity: corruption must still fail.
  const good = encodeModelBlob({ a: 'x'.repeat(2_000) }, ENCODE_OPTS);
  const tampered = { ...good, payload: encodeModelBlob({ a: 'y'.repeat(2_000) }, ENCODE_OPTS).payload };
  assert.equal(decodeModelBlob(tampered, { allowVersionMismatch: true }).ok, false);
  assert.equal(decodeModelBlob({ ...good, encoding: 'gzip+base64' }, { allowVersionMismatch: true }).ok, false);
});

test('a matching blob produces no warnings even with the override on', () => {
  const res = decodeModelBlob(encodeModelBlob({ a: 1 }, ENCODE_OPTS), { allowVersionMismatch: true });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.warnings, undefined);
});

test('decode rejects a truncated payload via the checksum', () => {
  const blob = encodeModelBlob({ a: 'x'.repeat(5_000) }, ENCODE_OPTS);
  // Re-encode different content but keep the original checksum: exactly what a
  // mangled copy/paste through an agent's context looks like.
  const tampered = { ...blob, payload: encodeModelBlob({ a: 'y'.repeat(5_000) }, ENCODE_OPTS).payload };
  const res = decodeModelBlob(tampered);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /checksum/);
});

test('decode never throws on garbage — every failure is a diagnosable result', () => {
  for (const bad of [null, undefined, 42, 'not json', '{}', {}, { payload: 'not base64 brotli' }]) {
    const res = decodeModelBlob(bad);
    assert.equal(res.ok, false, `expected failure for ${JSON.stringify(bad)}`);
    if (!res.ok) assert.ok(res.error.length > 0);
  }
});

test('decode reports a corrupt payload distinctly from a bad envelope', () => {
  const res = decodeModelBlob({ ...encodeModelBlob({ a: 1 }, ENCODE_OPTS), payload: 'bm90IGJyb3RsaQ==' });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /corrupt/);
});

// ── connection introspection ────────────────────────────────────────

test('modelConnections derives every (connection → dialect) pair', () => {
  const def = {
    contents: {
      a: { connection: 'duckdb', dialect: 'duckdb', fields: [{ connection: 'duckdb', dialect: 'duckdb' }] },
      b: { connection: 'warehouse', dialect: 'bigquery' },
    },
  };
  assert.deepEqual([...modelConnections(def)].sort(), [
    ['duckdb', 'duckdb'],
    ['warehouse', 'bigquery'],
  ]);
});

test('modelConnections terminates on a cyclic def', () => {
  const def: Record<string, unknown> = { connection: 'c', dialect: 'duckdb' };
  def['self'] = def;
  assert.deepEqual([...modelConnections(def)], [['c', 'duckdb']]);
});

// ── the real claim: compiled WITH a driver, queried WITHOUT one ──────

/** A connection that can describe a dialect and nothing else. If the client
    ever needs more than this, the no-driver premise has broken. */
function stubConnection(name: string, dialect: string) {
  return {
    name,
    dialectName: dialect,
    get isPool() { return false; },
    get isStreaming() { return false; },
    runSQL: () => Promise.reject(new Error('compile-only client: runSQL must never be called')),
    fetchSchemaForTables: () => Promise.reject(new Error('compile-only client: schema fetch must never happen')),
    fetchSchemaForSQLStruct: () => Promise.reject(new Error('compile-only client: schema fetch must never happen')),
    estimateQueryCost: () => Promise.reject(new Error('compile-only')),
    close: () => Promise.resolve(),
  };
}

test('a blob from a real compiled model rehydrates and compiles with NO driver', async () => {
  // 1. Compile for real (DuckDB present) and extract the def.
  const def = await withFixtureRuntime(async (rt) => {
    const model = await rt.loadModel(fixtureUrl('artifacts_model.malloy')).getModel();
    return extractModelDef(model);
  });

  // 2. Ship it through the envelope.
  const res = decodeModelBlob(encodeModelBlob(def, ENCODE_OPTS));
  assert.equal(res.ok, true);
  if (!res.ok) return;

  // 3. Re-open with connections that cannot fetch a schema or run SQL.
  const conns = modelConnections(res.def);
  assert.deepEqual([...conns], [['duckdb', 'duckdb']]);
  const stubs = new Map([...conns].map(([n, d]) => [n, stubConnection(n, d)]));
  const runtime = new Runtime({
    urlReader: { readURL: () => Promise.reject(new Error('client has no source files')) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    connections: { lookupConnection: (n?: string) => Promise.resolve((stubs.get(n ?? 'duckdb') ?? [...stubs.values()][0]) as any) },
  });
  const mm = rehydrateModel(runtime, res.def);

  // 4. A good query compiles to SQL...
  const sql = await mm.loadQuery('run: nums -> { aggregate: c is count() }').getSQL();
  assert.match(sql, /COUNT\(/i);

  // ...and a bad one returns a real Malloy diagnostic, which is the whole
  // point: the agent learns the query is wrong without a round trip.
  await assert.rejects(
    () => mm.loadQuery('run: nums -> { group_by: not_a_field }').getSQL(),
    (e: Error & { problems?: Array<{ message: string }> }) => {
      assert.ok(e.problems?.some((p) => /not_a_field/.test(p.message)), e.message);
      return true;
    },
  );
});

test('the engine `compile` walker also runs against a rehydrated model', async () => {
  // describe_source / list_sources go through compile(), so the client's
  // describe output is the SERVER'S code path, not a lookalike.
  const def = await withFixtureRuntime(async (rt) =>
    extractModelDef(await rt.loadModel(fixtureUrl('artifacts_model.malloy')).getModel()),
  );
  const res = decodeModelBlob(encodeModelBlob(def, ENCODE_OPTS));
  assert.equal(res.ok, true);
  if (!res.ok) return;

  const stub = stubConnection('duckdb', 'duckdb');
  const runtime = new Runtime({
    urlReader: { readURL: () => Promise.reject(new Error('no files')) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    connection: stub as any,
  });
  const entry = new URL('file:///model.malloy');
  const original = runtime.loadModel.bind(runtime);
  Object.defineProperty(runtime, 'loadModel', {
    configurable: true,
    value: (u: URL) => (u.href === entry.href ? rehydrateModel(runtime, res.def) : original(u)),
  });

  const compiled = await compile(runtime, entry);
  assert.equal(compiled.ok, true);
  assert.ok(compiled.model);
  assert.ok(Object.keys(compiled.model!.sources).includes('nums'));
});
