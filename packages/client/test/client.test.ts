// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The client's contract: it answers the explore surface's questions from a
// compiled model, with no database driver, no credentials and no network — and
// it says something useful when it cannot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { promisify } from 'node:util';
import { exploreSurface, type SourceDescribeResult } from '@malloyyo/mcp-engine';
import { ClientError, openModelBlob } from '../src/model';
import { makeBlob, blobFile } from './helpers';

const execFileP = promisify(execFile);
const here = path.dirname(url.fileURLToPath(import.meta.url));
const BIN = path.join(here, '..', 'dist', 'index.js');

/** Run the built binary; never throws on a non-zero exit. */
async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [BIN, ...args]);
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

// ── the library ─────────────────────────────────────────────────────

test('list_sources reports the model and its exported sources', async () => {
  const { host } = openModelBlob(await makeBlob());
  const list = await host.list!();
  assert.equal(list.entries.length, 1);
  assert.equal(list.entries[0]!.model_ref, 'demo');
  assert.deepEqual(list.entries[0]!.sources?.map((s) => s.source_ref), ['orders']);
});

test('describe_source resolves fields, measures and views with no driver', async () => {
  const { host } = openModelBlob(await makeBlob());
  // Through the real tool, so this asserts what an agent actually receives.
  const tool = exploreSurface(host).tools.find((t) => t.name === 'describe_source')!;
  const res = (await tool.handler({ source: 'orders', model_ref: 'demo' })) as SourceDescribeResult;
  assert.equal(res.ok, true, JSON.stringify(res.problems));

  const src = res.described_source!;
  const names = new Set(Object.keys(src.dimensions ?? {}));
  for (const m of Object.keys(src.measures ?? {})) names.add(m);
  for (const expected of ['id', 'state', 'amount', 'order_count', 'total_amount']) {
    assert.ok(names.has(expected), `missing ${expected} in ${[...names].join(', ')}`);
  }
  assert.deepEqual(Object.keys(src.views), ['by_state']);
  // Doc comments survive the round trip — describe output is the real thing,
  // not a thinned-out copy.
  assert.match(src.views['by_state'] ?? '', /by state/i);
});

test('a wrong model_ref names the model this file actually holds', async () => {
  const { host } = openModelBlob(await makeBlob(undefined, { model_ref: 'sales' }));
  await assert.rejects(
    () => host.withModel('marketing', async () => undefined),
    (e: Error) => {
      assert.ok(e instanceof ClientError);
      assert.match(e.message, /holds 'sales', not 'marketing'/);
      return true;
    },
  );
});

test('opening a blob from a different Malloy fails with the client to install', async () => {
  const blob = { ...(await makeBlob(undefined, { client_version: '1.2.3' })), malloy_version: '0.0.1-ancient' };
  assert.throws(
    () => openModelBlob(blob),
    (e: Error) => {
      assert.ok(e instanceof ClientError);
      assert.match(e.message, /malloyyo-client@1\.2\.3/);
      return true;
    },
  );
});

test('--any-version opens a mismatched blob and warns on stderr, not stdout', async () => {
  const bad = { ...(await makeBlob()), malloy_version: '0.0.0-other' };
  const dir = mkdtempSync(path.join(tmpdir(), 'malloyyo-anyver-'));
  const file = path.join(dir, 'model.json');
  writeFileSync(file, JSON.stringify(bad));

  assert.equal((await run(['--model', file, 'list_sources'])).code, 2, 'must refuse by default');

  const r = await run(['--model', file, '--any-version', 'list_sources']);
  assert.equal(r.code, 0, r.stderr);
  // stdout stays parseable JSON — a warning that broke `| jq` would make the
  // escape hatch unusable in exactly the scripts that need it.
  assert.ok((JSON.parse(r.stdout) as { models: Record<string, unknown> }).models['demo']);
  assert.match(r.stderr, /0\.0\.0-other/);
  assert.match(r.stderr, /version check off/i);
});

test('MALLOYYO_ANY_VERSION=1 is equivalent to the flag', async () => {
  const bad = { ...(await makeBlob()), malloy_version: '0.0.0-other' };
  const dir = mkdtempSync(path.join(tmpdir(), 'malloyyo-anyver-env-'));
  const file = path.join(dir, 'model.json');
  writeFileSync(file, JSON.stringify(bad));
  const { stdout } = await execFileP(process.execPath, [BIN, '--model', file, 'list_sources'], {
    env: { ...process.env, MALLOYYO_ANY_VERSION: '1' },
  });
  assert.ok((JSON.parse(stdout) as { models: Record<string, unknown> }).models['demo']);
});

// ── the binary ──────────────────────────────────────────────────────

test('query compiles a good query to SQL and exits 0', async () => {
  const file = await blobFile();
  const r = await run(['--model', file, 'query', 'orders', 'run: orders -> by_state']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout) as { ok: boolean; sql?: string };
  assert.equal(out.ok, true);
  assert.match(out.sql ?? '', /SELECT/i);
  // Compile-only means exactly that: no rows, ever.
  assert.ok(!('rows' in out), 'compile-only result must not carry rows');
});

test('query reports a bad field as a problem and exits 1', async () => {
  const file = await blobFile();
  const r = await run(['--model', file, 'query', 'orders', 'run: orders -> { group_by: nope }']);
  assert.equal(r.code, 1);
  const out = JSON.parse(r.stdout) as { ok: boolean; problems: Array<{ message: string }> };
  assert.equal(out.ok, false);
  assert.ok(out.problems.some((p) => /nope/.test(p.message)), JSON.stringify(out.problems));
});

test('the exit code is the whole signal — good vs bad query differ', async () => {
  const file = await blobFile();
  const good = await run(['--model', file, 'query', 'orders', 'run: orders -> { aggregate: order_count }']);
  const bad = await run(['--model', file, 'query', 'orders', 'run: orders -> { aggregate: not_a_measure }']);
  assert.equal(good.code, 0);
  assert.equal(bad.code, 1);
});

test('list_sources and describe_source run from the command line', async () => {
  const file = await blobFile();
  const list = await run(['--model', file, 'list_sources']);
  assert.equal(list.code, 0, list.stderr);
  assert.ok((JSON.parse(list.stdout) as { models: Record<string, unknown> }).models['demo']);

  const desc = await run(['--model', file, 'describe_source', 'orders']);
  assert.equal(desc.code, 0, desc.stderr);
  const out = JSON.parse(desc.stdout) as { ok: boolean; source: string };
  assert.equal(out.ok, true);
  assert.equal(out.source, 'orders');
});

test('info reports the versions that must match', async () => {
  const file = await blobFile(undefined, { model_ref: 'demo', client_version: '4.5.6' });
  const r = await run(['--model', file, 'info']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout) as Record<string, unknown>;
  assert.equal(out['model_ref'], 'demo');
  assert.equal(out['client_version'], '4.5.6');
  assert.ok(typeof out['malloy_version'] === 'string');
});

test('yo_help works offline — the authoring guide ships in the binary', async () => {
  const file = await blobFile();
  const r = await run(['--model', file, 'yo_help']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout) as { topics: unknown[] };
  assert.ok(Array.isArray(out.topics) && out.topics.length > 0);
});

test('the model is read from MALLOYYO_MODEL when --model is absent', async () => {
  const file = await blobFile();
  const { stdout } = await execFileP(process.execPath, [BIN, 'list_sources'], {
    env: { ...process.env, MALLOYYO_MODEL: file },
  });
  assert.ok((JSON.parse(stdout) as { models: Record<string, unknown> }).models['demo']);
});

test('a missing model file is a usage error (exit 2), not a crash', async () => {
  const r = await run(['--model', '/nonexistent/model.json', 'list_sources']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /cannot read model file/);
  assert.doesNotMatch(r.stderr, /at Object\./, 'should not print a stack trace');
});

test('no model file at all explains where to get one', async () => {
  const { code, stderr } = await run(['list_sources']);
  assert.equal(code, 2);
  assert.match(stderr, /fetch_compiled_model|malloyyo compile/);
});

test('an unknown command lists the real ones', async () => {
  const file = await blobFile();
  const r = await run(['--model', file, 'describe_sources']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /list_sources/);
  assert.match(r.stderr, /describe_source/);
});

test('--help and --version work with no model present', async () => {
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /compile-only|Compile and debug/);
  const ver = await run(['--version']);
  assert.equal(ver.code, 0);
  assert.match(ver.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test('--compact emits one line, the default emits indented JSON', async () => {
  const file = await blobFile();
  const compact = await run(['--model', file, '--compact', 'list_sources']);
  const pretty = await run(['--model', file, 'list_sources']);
  assert.equal(compact.stdout.trimEnd().split('\n').length, 1);
  assert.ok(pretty.stdout.split('\n').length > 1);
});
