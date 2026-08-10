// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The client's contract: it answers the explore surface's questions from a
// compiled model, with no database driver, no credentials and no network — and
// it says something useful when it cannot.

import { after, test } from 'node:test';
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
const BIN = path.join(here, '..', 'dist', 'index.cjs');

/**
 * Run the built binary; never throws on a non-zero exit.
 *
 * The daemon is OFF here. A resident daemon is ~100MB, and every test that
 * touched the binary used to fork one and leave it running — 14 processes and a
 * gigabyte by the end of a single run. The daemon tests below opt back in
 * explicitly and stop what they start.
 */
async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [BIN, ...args], {
      env: { ...process.env, MALLOYYO_NO_DAEMON: '1' },
    });
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
    env: { ...process.env, MALLOYYO_ANY_VERSION: '1', MALLOYYO_NO_DAEMON: '1' },
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
    env: { ...process.env, MALLOYYO_MODEL: file, MALLOYYO_NO_DAEMON: '1' },
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

// ── the resident compiler ───────────────────────────────────────────

/** Every model file a daemon test touched, so `after` can guarantee cleanup. */
const daemonModels = new Set<string>();

/** Run with the daemon ENABLED. Short idle, so anything these tests miss
    expires in seconds rather than sitting on 100MB for two minutes. */
async function runD(args: string[], env: Record<string, string> = {}) {
  const i = args.indexOf('--model');
  if (i >= 0 && args[i + 1]) daemonModels.add(args[i + 1]!);
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [BIN, ...args], {
      env: { ...process.env, MALLOYYO_NO_DAEMON: '', MALLOYYO_DAEMON_IDLE_MS: '5000', ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

after(async () => {
  for (const file of daemonModels) {
    await runD(['--model', file, 'daemon', 'stop']).catch(() => undefined);
  }
});

/** Poll until the forked daemon is answering (it starts after the first call). */
async function awaitDaemon(file: string, tries = 60): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const r = await runD(['--model', file, '--compact', 'daemon', 'status']);
    if ((JSON.parse(r.stdout) as { running: boolean }).running) return true;
    await new Promise((r2) => setTimeout(r2, 100));
  }
  return false;
}

test('a daemon starts after the first call and then answers subsequent ones', async () => {
  const file = await blobFile();
  const before = await runD(['--model', file, '--compact', 'daemon', 'status']);
  assert.equal((JSON.parse(before.stdout) as { running: boolean }).running, false);

  const first = await runD(['--model', file, 'query', 'orders', 'run: orders -> by_state']);
  assert.equal(first.code, 0, first.stderr);
  assert.ok(await awaitDaemon(file), 'daemon should be up after the first call');

  // The claim that matters: a served answer is identical to a direct one.
  const served = await runD(['--model', file, '--compact', 'query', 'orders', 'run: orders -> by_state']);
  const direct = await run(['--model', file, '--compact', '--no-daemon', 'query', 'orders', 'run: orders -> by_state']);
  assert.equal(served.stdout, direct.stdout);
  assert.equal(served.code, direct.code);

  await runD(['--model', file, 'daemon', 'stop']);
});

test('the daemon preserves exit codes and stderr, not just stdout', async () => {
  const file = await blobFile();
  await runD(['--model', file, 'info']);
  assert.ok(await awaitDaemon(file));

  const bad = await runD(['--model', file, 'query', 'orders', 'run: orders -> { group_by: nope }']);
  assert.equal(bad.code, 1, 'a failed compile must still exit 1 through the daemon');
  assert.match(bad.stdout, /nope/);

  const usage = await runD(['--model', file, 'describe_source']);
  assert.equal(usage.code, 2, 'a usage error must still exit 2 through the daemon');
  assert.match(usage.stderr, /needs a source name/);

  await runD(['--model', file, 'daemon', 'stop']);
});

test('editing the model file addresses a NEW daemon, never a stale one', async () => {
  const file = await blobFile(undefined, { model_ref: 'first' });
  await runD(['--model', file, 'info']);
  assert.ok(await awaitDaemon(file));
  const sockBefore = (JSON.parse(
    (await runD(['--model', file, '--compact', 'daemon', 'status'])).stdout,
  ) as { socket: string }).socket;

  // Same path, different content — the classic stale-cache trap.
  await new Promise((r) => setTimeout(r, 10)); // ensure a distinct mtime
  writeFileSync(file, JSON.stringify(await makeBlob(undefined, { model_ref: 'second' })));

  const status = JSON.parse(
    (await runD(['--model', file, '--compact', 'daemon', 'status'])).stdout,
  ) as { running: boolean; socket: string };
  assert.notEqual(status.socket, sockBefore, 'a changed model must map to a different socket');
  assert.equal(status.running, false, 'the old daemon must not serve the new model');

  const info = await runD(['--model', file, '--compact', 'info']);
  assert.equal((JSON.parse(info.stdout) as { model_ref: string }).model_ref, 'second');
});

test('--no-daemon neither uses nor starts one', async () => {
  const file = await blobFile();
  const r = await run(['--model', file, '--no-daemon', 'query', 'orders', 'run: orders -> by_state']);
  assert.equal(r.code, 0, r.stderr);
  await new Promise((res) => setTimeout(res, 500));
  const status = await runD(['--model', file, '--compact', 'daemon', 'status']);
  assert.equal((JSON.parse(status.stdout) as { running: boolean }).running, false);
});

test('daemon stop shuts it down', async () => {
  const file = await blobFile();
  await runD(['--model', file, 'info']);
  assert.ok(await awaitDaemon(file));
  const stopped = await runD(['--model', file, '--compact', 'daemon', 'stop']);
  assert.equal((JSON.parse(stopped.stdout) as { stopped: boolean }).stopped, true);
  await new Promise((r) => setTimeout(r, 300));
  const status = await runD(['--model', file, '--compact', 'daemon', 'status']);
  assert.equal((JSON.parse(status.stdout) as { running: boolean }).running, false);
});

test('a stale socket file does not wedge the client', async () => {
  const file = await blobFile();
  const sock = (JSON.parse(
    (await runD(['--model', file, '--compact', 'daemon', 'status'])).stdout,
  ) as { socket: string }).socket;
  // A daemon that died without cleaning up leaves exactly this behind.
  if (process.platform !== 'win32') {
    writeFileSync(sock, '');
    const r = await runD(['--model', file, 'query', 'orders', 'run: orders -> by_state']);
    assert.equal(r.code, 0, `a dead socket must fall through to a direct run: ${r.stderr}`);
  }
});

test('--compact emits one line, the default emits indented JSON', async () => {
  const file = await blobFile();
  const compact = await run(['--model', file, '--compact', 'list_sources']);
  const pretty = await run(['--model', file, 'list_sources']);
  assert.equal(compact.stdout.trimEnd().split('\n').length, 1);
  assert.ok(pretty.stdout.split('\n').length > 1);
});
