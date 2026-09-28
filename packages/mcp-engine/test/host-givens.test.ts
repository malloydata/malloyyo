// A host that scopes data by a given relies on THREE things, and core provides
// two of them. These tests pin all three against real compiles, because the
// whole feature is a security boundary and every one of them was got wrong at
// least once while it was being built.
//
//   1. core binds the host's runtime value and refuses a per-query override
//      (`config.finalizeGivens`);
//   2. core refuses to run at all when a finalized name has no value, and
//      refuses when the model stopped declaring it;
//   3. OURS: a query that never references the given is refused, so deleting
//      the `where:` cannot quietly unscope the data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as malloy from '@malloydata/malloy';
import { runRestricted, unreferencedGivens, unreferencedGivensMessage } from '../src/index';

// Importing a db-* package self-registers it on malloy's module-level registry,
// which is what a `{"is": "duckdb"}` connection in the config resolves against.
import '@malloydata/db-duckdb/native';

const BASE = 'file:///t/';
const SQL = 'duckdb.sql("SELECT \'a@b.com\' as who UNION ALL SELECT \'c@d.com\' as who")';
const DECL = ['##! experimental { givens }', 'given:', "  MALLOYYO_EMAIL :: string is ''"];

/** Scoped the way an author should write it: the filter is on the SOURCE. */
const SCOPED = DECL.concat([
  'source: mine is ' + SQL + ' extend { where: who = $MALLOYYO_EMAIL }',
  'query: rows is mine -> { select: who }',
]).join('\n');

/** The accident: declaration kept, filter deleted. */
const UNSCOPED = DECL.concat([
  'source: mine is ' + SQL,
  'query: rows is mine -> { select: who }',
]).join('\n');

/** The rogue edit: the declaration itself is gone. */
const NO_DECL = ['source: mine is ' + SQL, 'query: rows is mine -> { select: who }'].join('\n');

const REQUIRED = ['MALLOYYO_EMAIL'];

function config(finalize: boolean) {
  return new malloy.MalloyConfig(
    JSON.stringify({
      connections: { duckdb: { is: 'duckdb' } },
      ...(finalize ? { finalizeGivens: REQUIRED } : {}),
    }),
    { overlays: malloy.defaultConfigOverlays() },
  );
}

async function run(
  src: string,
  opts: { email?: string; gate?: boolean; override?: string } = {},
) {
  const cfg = config(true);
  try {
    const reader = new malloy.InMemoryURLReader(new Map([[BASE + 'm.malloy', src]]));
    const runtime = new malloy.Runtime({
      config: cfg,
      urlReader: reader,
      ...(opts.email ? { givens: { MALLOYYO_EMAIL: opts.email } } : {}),
    } as never);
    const out = await runRestricted(runtime, new URL(BASE + 'm.malloy'), 'run: rows', {
      ...(opts.gate === false ? {} : { requireGivens: REQUIRED }),
      ...(opts.override ? { givens: { MALLOYYO_EMAIL: opts.override } } : {}),
    });
    return out.ok
      ? { ok: true as const, rows: out.rows }
      : { ok: false as const, why: (out.problems ?? []).map((p) => p.message).join(' | ') };
  } finally {
    await cfg.shutdown('close');
  }
}

test('the pure gate: refused only when a query references NONE of them', () => {
  assert.deepEqual(unreferencedGivens(REQUIRED, ['MALLOYYO_EMAIL', 'REGION']), []);
  assert.deepEqual(unreferencedGivens(REQUIRED, ['REGION']), ['MALLOYYO_EMAIL']);
  assert.deepEqual(unreferencedGivens([], ['whatever']), [], 'no requirement, no gate');

  // ANY, not all: a model scoped on two axes may filter one source by the
  // address and another by the roles, and every query need only be scoped by
  // something. Requiring both everywhere would make declaring two unusable.
  const both = ['MALLOYYO_EMAIL', 'MALLOYYO_ROLES'];
  assert.deepEqual(unreferencedGivens(both, ['MALLOYYO_EMAIL']), [], 'scoped by the address alone');
  assert.deepEqual(unreferencedGivens(both, ['MALLOYYO_ROLES']), [], 'scoped by the roles alone');
  assert.deepEqual(unreferencedGivens(both, ['REGION']), both, 'scoped by neither is refused');

  assert.match(unreferencedGivensMessage(['MALLOYYO_EMAIL']), /scoped by this given/);
});

test('a scoped model returns only the asker’s rows', async () => {
  const a = await run(SCOPED, { email: 'a@b.com' });
  assert.equal(a.ok, true, a.ok ? '' : a.why);
  assert.deepEqual(a.ok ? a.rows : [], [{ who: 'a@b.com' }]);

  const c = await run(SCOPED, { email: 'c@d.com' });
  assert.deepEqual(c.ok ? c.rows : [], [{ who: 'c@d.com' }]);
});

test('a caller cannot choose who they are', async () => {
  // core's finalizeGivens, not ours: the override throws at API entry.
  const r = await run(SCOPED, { email: 'a@b.com', override: 'c@d.com' });
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.why, /finalized at the runtime layer/);
});

test('no identity supplied → refused, never the declaration default', async () => {
  // An empty `filter<string>` means NO filter, so defaulting here would return
  // every tenant's rows to the one caller we could not identify.
  const r = await run(SCOPED, {});
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.why, /has no resolved value/);
});

test('the declaration removed → the dataset goes dark, not open', async () => {
  // TWO independent mechanisms refuse this, and it matters that both do: the
  // gate notices the query references nothing, and core notices the runtime is
  // supplying a name the model no longer surfaces. Whichever fires first, a
  // model that drops the declaration cannot serve.
  const gated = await run(NO_DECL, { email: 'a@b.com' });
  assert.equal(gated.ok, false);
  assert.match(gated.ok ? '' : gated.why, /references it nowhere/);

  const ungated = await run(NO_DECL, { email: 'a@b.com', gate: false });
  assert.equal(ungated.ok, false, 'core refuses on its own, gate or no gate');
  assert.match(ungated.ok ? '' : ungated.why, /unknown given/);
});

test('the FILTER removed → refused by the gate, though everything else passes', async () => {
  // The declaration is still there, so core is satisfied: it binds the value
  // happily. Only the usage gate notices that nothing consumes it.
  const ungated = await run(UNSCOPED, { email: 'a@b.com', gate: false });
  assert.equal(ungated.ok, true, 'core alone is satisfied');
  assert.equal(ungated.ok && ungated.rows?.length, 2, '…and returns EVERY row');

  const gated = await run(UNSCOPED, { email: 'a@b.com' });
  assert.equal(gated.ok, false, 'the gate catches it');
  assert.match(gated.ok ? '' : gated.why, /references it nowhere/);
});

test('a source-level filter carries the reference to every query over it', async () => {
  // `rows` is `mine -> { select: who }` — it never mentions the given. The
  // `where:` on the source is what makes it referenced, which is why the gate
  // costs an author nothing when they filter in the right place.
  const r = await run(SCOPED, { email: 'a@b.com' });
  assert.equal(r.ok, true, r.ok ? '' : r.why);
});
