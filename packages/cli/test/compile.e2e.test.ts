// End-to-end across the two halves: `malloyyo compile` writes a blob with the
// heavy stack (DuckDB, drivers, the lot), and `malloyyo_client` answers
// questions about it with none of that installed.
//
// This is the seam the whole feature rests on, and it spans two packages, so
// neither package's own tests can cover it — it lives here, where the producer
// does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const here = path.dirname(url.fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'dist', 'index.js');
const CLIENT = path.join(here, '..', '..', 'client', 'dist', 'index.js');

const MODEL = `
source: orders is duckdb.sql("""
  SELECT 1 as id, 'CA' as state, 10.5 as amount UNION ALL
  SELECT 2, 'NY', 20.0 UNION ALL
  SELECT 3, 'CA', 5.25
""") extend {
  measure: order_count is count()
  measure: total_amount is amount.sum()
  view: by_state is { group_by: state; aggregate: order_count, total_amount }
}
`;

/** A throwaway model repo with an index.malloy. */
function modelRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'malloyyo-compile-'));
  writeFileSync(path.join(dir, 'index.malloy'), MODEL);
  return dir;
}

async function client(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [CLIENT, ...args]);
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('compile writes a blob the client can query, with no driver on the client side', async () => {
  const dir = modelRepo();
  const out = path.join(dir, 'model.json');
  await execFileP(process.execPath, [CLI, 'compile', '-C', dir, '-o', out, '--model-ref', 'shop']);

  const blob = JSON.parse(readFileSync(out, 'utf8')) as {
    model_ref: string;
    payload: string;
    bytes: number;
    client_version: string;
  };
  assert.equal(blob.model_ref, 'shop');
  // The blob has to be worth shipping through a tool result.
  assert.ok(blob.payload.length < blob.bytes / 3, `expected real compression, got ${blob.bytes} -> ${blob.payload.length}`);
  assert.match(blob.client_version, /^\d+\.\d+\.\d+/);

  const list = await client(['--model', out, 'list_sources']);
  assert.equal(list.code, 0, list.stderr);
  assert.ok((JSON.parse(list.stdout) as { models: Record<string, unknown> }).models['shop']);

  const good = await client(['--model', out, 'query', 'orders', 'run: orders -> by_state']);
  assert.equal(good.code, 0, good.stderr);
  assert.match((JSON.parse(good.stdout) as { sql: string }).sql, /GROUP BY/i);

  const bad = await client(['--model', out, 'query', 'orders', 'run: orders -> { group_by: nope }']);
  assert.equal(bad.code, 1);
  assert.match(bad.stdout, /nope/);
});

test('compile -o - writes the blob to stdout', async () => {
  const dir = modelRepo();
  const { stdout } = await execFileP(process.execPath, [CLI, 'compile', '-C', dir, '-o', '-']);
  const blob = JSON.parse(stdout) as { payload: string; model_ref: string };
  assert.ok(blob.payload.length > 0);
  // Default model_ref is the directory name, so a blob is always self-labelling.
  assert.equal(blob.model_ref, path.basename(dir));
});

test('compile refuses a directory with no index.malloy, and says why', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'malloyyo-empty-'));
  await assert.rejects(
    () => execFileP(process.execPath, [CLI, 'compile', '-C', dir, '-o', '-']),
    (e: Error & { stderr?: string }) => {
      assert.match(e.stderr ?? e.message, /no index\.malloy/);
      return true;
    },
  );
});
