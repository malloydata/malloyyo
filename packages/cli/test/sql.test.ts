// End-to-end: `malloyyo sql` — the typed path and its fallback (malloyyo#137).
//
// Row-returning SQL goes through Malloy as `<conn>.sql("…")`, so the result
// carries a schema and jsonRows can tell a BIGINT from a VARCHAR. Statements
// Malloy cannot type fall back to the raw driver. These pin both, plus the
// string escaping that lets arbitrary SQL survive the trip into a Malloy
// string literal.
//
// Spawned rather than called in-process (same shape as mcp.e2e.test.ts):
// capturing process.stdout in-process would swallow node:test's own reporter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const here = path.dirname(url.fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'dist', 'index.js');
// An empty root, so config discovery can't wander into the repo's own settings
// and pick up a connection this test didn't ask for.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'malloyyo-sql-'));

async function sql(statement: string, json = true): Promise<string> {
  const args = [CLI, 'sql', '-C', ROOT, '-e', statement];
  if (json) args.push('--json');
  const { stdout } = await execFileP('node', args, { maxBuffer: 8 << 20 });
  return stdout;
}

const rows = async (statement: string): Promise<Record<string, unknown>[]> =>
  JSON.parse(await sql(statement)) as Record<string, unknown>[];

test('sql --json: BIGINT is a number, VARCHAR stays a string', async () => {
  const [row] = await rows("SELECT 1::BIGINT as big, '42' as strcol, 127::TINYINT as tiny");
  assert.equal(row!['big'], 1, 'BIGINT narrowed to a JSON number');
  assert.equal(typeof row!['big'], 'number');
  // The whole point: on the untyped path these two are indistinguishable.
  assert.equal(row!['strcol'], '42', 'a real string column is untouched');
  assert.equal(typeof row!['strcol'], 'string');
  assert.equal(row!['tiny'], 127);
});

test('sql --json: values past MAX_SAFE_INTEGER stay exact strings', async () => {
  const [row] = await rows('SELECT 9007199254740993::BIGINT as huge');
  assert.equal(row!['huge'], '9007199254740993');
});

test('sql --json: dates match the rest of Malloyyo (ISO)', async () => {
  // Not DuckDB's own "2020-01-02": going through Malloy means one date format
  // across the CLI, the MCP surface, and dashboards.
  const [row] = await rows("SELECT DATE '2020-01-02' as d");
  assert.equal(row!['d'], '2020-01-02T00:00:00.000Z');
});

// Escaping cases — each of these defeats a naive `"""` fence.
for (const [label, statement, expected] of [
  ['a trailing semicolon', 'SELECT 1::BIGINT as n;', 1],
  ['a trailing -- comment', 'SELECT 2::BIGINT as n -- note', 2],
  ['multiple lines', 'SELECT\n  3::BIGINT as n', 3],
  ['a tab', "SELECT 4::BIGINT as n, 'a\tb' as s", 4],
  ['a backslash', "SELECT 5::BIGINT as n, 'a\\b' as s", 5],
] as const) {
  test(`sql --json: survives ${label}`, async () => {
    const [row] = await rows(statement);
    assert.equal(row!['n'], expected, 'took the typed path');
  });
}

test('sql --json: SQL containing a triple double-quote still types', async () => {
  // Why the SQL is escaped into a one-line string rather than fenced: no choice
  // of fence is safe against SQL that happens to contain it.
  const [row] = await rows(`SELECT '"""' as q, 6::BIGINT as n`);
  assert.equal(row!['q'], '"""');
  assert.equal(row!['n'], 6, 'still went through the typed path');
});

test('sql: a statement Malloy cannot type falls back instead of failing', async () => {
  // DDL has no schema to project. It must still run, exactly once, and report.
  assert.match(await sql('CREATE TABLE fallback_probe (a INT)', false), /no result rows/);
});

test('sql: COPY runs its side effect exactly once via the fallback', async () => {
  const out = path.join(ROOT, 'copy_probe.parquet');
  await sql(`COPY (SELECT 1::BIGINT as a) TO '${out}'`, false);
  assert.ok(fs.existsSync(out), 'the typed attempt failed to COMPILE, so nothing ran twice');
  // And reading it back goes through the typed path, so the BIGINT is a number.
  const [row] = await rows(`SELECT * FROM '${out}'`);
  assert.equal(row!['a'], 1);
});

test('sql: a failing statement still surfaces its error', async () => {
  await assert.rejects(
    () => sql('SELECT * FROM definitely_not_a_table'),
    /definitely_not_a_table/,
  );
});
