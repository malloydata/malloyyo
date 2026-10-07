// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The update notice. Two things are worth pinning: the version comparison,
// which is hand-rolled rather than a semver dependency, and the rule that the
// notice NEVER reaches stdout — `malloyyo mcp` speaks JSON-RPC there, so a
// stray line is a protocol error rather than a cosmetic one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isNewer, noticeOnExit, UPDATE_CHECK_ARGV } from '../src/update-check.js';
import { version as VERSION } from '../package.json';

test('isNewer: both directions, and the cases a wrong answer would be visible in', () => {
  // The direction that matters: it must say yes when there is genuinely a newer
  // release, which is the whole point.
  assert.equal(isNewer('0.2.57', '0.2.46'), true, 'a later patch is newer');
  assert.equal(isNewer('0.3.0', '0.2.99'), true, 'minor beats a bigger patch');
  assert.equal(isNewer('1.0.0', '0.9.9'), true, 'major beats a bigger minor');

  // And the direction that would be embarrassing: telling someone on the
  // newest build to upgrade.
  assert.equal(isNewer('0.2.46', '0.2.57'), false, 'an older release is not newer');
  assert.equal(isNewer('0.2.57', '0.2.57'), false, 'equal is not newer');
  assert.equal(isNewer('0.2.9', '0.2.10'), false, 'compared numerically, not as text');

  // Segment counts need not match.
  assert.equal(isNewer('0.3', '0.2.9'), true, 'a short version still compares');
  assert.equal(isNewer('0.2.0', '0.2'), false, 'a trailing zero is not an upgrade');

  // A prerelease must not read as newer than the release it precedes, or every
  // `0.2.58-beta.1` on the registry would nag everyone on 0.2.58.
  assert.equal(isNewer('0.2.58-beta.1', '0.2.58'), false, 'a prerelease is not an upgrade');

  // Garbage parses to zeros rather than throwing — silence, not a crash.
  assert.equal(isNewer('', VERSION), false, 'an empty string says nothing');
  assert.equal(isNewer('not-a-version', VERSION), false, 'junk says nothing');
});

/** Run `noticeOnExit` with a seeded cache and report what it wrote where.
 *
 *  It registers a `process.exit` handler rather than printing immediately, so
 *  the test drives that handler itself: `process.emit("exit")` is what the
 *  runtime would do, and it is the only way to observe the notice without
 *  ending the test process. */
function runNotice(argv: string[], cache: Record<string, unknown> | null) {
  const dir = mkdtempSync(path.join(tmpdir(), 'malloyyo-update-'));
  const file = path.join(dir, 'update-check.json');
  const prevCacheDir = process.env.MALLOYYO_CACHE_DIR;
  const prevCi = process.env.CI;
  const prevOff = process.env.MALLOYYO_NO_UPDATE_CHECK;
  process.env.MALLOYYO_CACHE_DIR = dir;
  delete process.env.CI;
  delete process.env.MALLOYYO_NO_UPDATE_CHECK;
  if (cache) writeFileSync(file, JSON.stringify(cache));

  const out: string[] = [];
  const err: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c: string) => { out.push(String(c)); return true; };
  process.stderr.write = (c: string) => { err.push(String(c)); return true; };

  const before = process.listenerCount('exit');
  try {
    noticeOnExit(argv);
    // Fire only the handlers this call added.
    const added = process.listeners('exit').slice(before);
    for (const h of added) {
      (h as () => void)();
      process.removeListener('exit', h as () => void);
    }
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    if (prevCacheDir === undefined) delete process.env.MALLOYYO_CACHE_DIR;
    else process.env.MALLOYYO_CACHE_DIR = prevCacheDir;
    if (prevCi !== undefined) process.env.CI = prevCi;
    if (prevOff !== undefined) process.env.MALLOYYO_NO_UPDATE_CHECK = prevOff;
  }
  return { stdout: out.join(''), stderr: err.join(''), file };
}

const AHEAD = { latest: '999.0.0', checkedAt: Date.now() };

test('the notice goes to stderr and never to stdout', () => {
  const { stdout, stderr } = runNotice(['node', 'malloyyo', 'status'], AHEAD);
  assert.match(stderr, /999\.0\.0 is available/, 'it says what is available');
  assert.match(stderr, /npm i -g @malloydata\/malloyyo@latest/, 'and what to run');
  assert.equal(stdout, '', 'NOTHING on stdout — mcp and sql are consumed there');
});

test('silent for the commands whose stdout is a protocol, and in CI', () => {
  for (const cmd of ['mcp', 'sql', UPDATE_CHECK_ARGV]) {
    const { stdout, stderr } = runNotice(['node', 'malloyyo', cmd], AHEAD);
    assert.equal(stderr, '', `${cmd}: no notice`);
    assert.equal(stdout, '', `${cmd}: no stdout either`);
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'malloyyo-update-ci-'));
  process.env.MALLOYYO_CACHE_DIR = dir;
  process.env.CI = '1';
  try {
    const err: string[] = [];
    const realErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (c: string) => { err.push(String(c)); return true; };
    const before = process.listenerCount('exit');
    noticeOnExit(['node', 'malloyyo', 'status']);
    assert.equal(process.listenerCount('exit'), before, 'CI registers no handler at all');
    process.stderr.write = realErr;
    assert.equal(err.join(''), '', 'nothing printed in CI');
  } finally {
    delete process.env.CI;
    delete process.env.MALLOYYO_CACHE_DIR;
  }
});

test('says nothing when already current, or on a first run with no cache', () => {
  const current = runNotice(['node', 'malloyyo', 'status'], { latest: VERSION, checkedAt: Date.now() });
  assert.equal(current.stderr, '', 'the newest build is not told to upgrade');

  // No cache: the check is started in the background and this run is silent,
  // which is the "never wait on the network" rule showing through.
  const fresh = runNotice(['node', 'malloyyo', 'status'], null);
  assert.equal(fresh.stderr, '', 'a first run has nothing to say yet');
});

test('having said it once, it does not say it again until the interval passes', () => {
  const justSaid = runNotice(['node', 'malloyyo', 'status'], { ...AHEAD, notifiedAt: Date.now() });
  assert.equal(justSaid.stderr, '', 'not twice in a row');

  const longAgo = runNotice(['node', 'malloyyo', 'status'], {
    ...AHEAD,
    notifiedAt: Date.now() - 1000 * 60 * 60 * 24 * 30,
  });
  assert.match(longAgo.stderr, /999\.0\.0/, 'but it does come back');

  // And it records that it spoke, so the next command is quiet.
  const { file } = runNotice(['node', 'malloyyo', 'status'], AHEAD);
  assert.ok(existsSync(file), 'the cache was written');
  const written = JSON.parse(readFileSync(file, 'utf8')) as { notifiedAt?: number };
  assert.ok(typeof written.notifiedAt === 'number', 'notifiedAt was stamped');
});

test('MALLOYYO_NO_UPDATE_CHECK silences it completely', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'malloyyo-update-off-'));
  process.env.MALLOYYO_CACHE_DIR = dir;
  process.env.MALLOYYO_NO_UPDATE_CHECK = '1';
  try {
    const before = process.listenerCount('exit');
    noticeOnExit(['node', 'malloyyo', 'status']);
    assert.equal(process.listenerCount('exit'), before, 'no handler, so nothing can print');
  } finally {
    delete process.env.MALLOYYO_NO_UPDATE_CHECK;
    delete process.env.MALLOYYO_CACHE_DIR;
  }
});
