// A writable HOME is a hard requirement for DuckDB (it keeps its extension
// store in $HOME/.duckdb and resolves that from the variable itself), and the
// hosts that break it — serverless sandboxes, containers run as a uid with no
// passwd entry, read-only root filesystems — report the breakage as an IO error
// that never mentions HOME. These pin the detection and the relocation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describeHomeFix, ensureWritableHome, homeDirProblem } from '../src/index';

/** A scratch directory removed when the test file ends. */
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'yo-home-test-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

function tmpDirFor(name: string): string {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

test('homeDirProblem: a normal directory is usable', () => {
  assert.equal(homeDirProblem(tmpDirFor('normal')), null);
});

test('homeDirProblem: unset, missing, and not-a-directory are all rejected', () => {
  assert.equal(homeDirProblem(undefined), 'is not set');
  assert.equal(homeDirProblem(''), 'is not set');
  assert.equal(homeDirProblem(path.join(scratch, 'nope', 'nope')), 'does not exist');
  const file = path.join(scratch, 'a-file');
  fs.writeFileSync(file, '');
  assert.equal(homeDirProblem(file), 'is not a directory');
});

test('homeDirProblem: an existing but unwritable .duckdb is rejected', { skip: asRoot }, () => {
  const home = tmpDirFor('locked-store');
  const store = path.join(home, '.duckdb');
  fs.mkdirSync(store);
  fs.chmodSync(store, 0o500);
  try {
    assert.match(homeDirProblem(home) ?? '', /\.duckdb/);
  } finally {
    fs.chmodSync(store, 0o700);
  }
});

test('homeDirProblem: a read-only home is rejected', { skip: asRoot }, () => {
  const home = tmpDirFor('read-only');
  fs.chmodSync(home, 0o500);
  try {
    assert.match(homeDirProblem(home) ?? '', /is not writable/);
  } finally {
    fs.chmodSync(home, 0o700);
  }
});

test('ensureWritableHome: a usable HOME is left exactly alone', () => {
  const home = tmpDirFor('keep-me');
  const env = { HOME: home, USERPROFILE: home };
  const fix = ensureWritableHome({ env, tmpDir: tmpDirFor('unused-tmp') });
  assert.equal(fix.changed, false);
  assert.equal(fix.home, home);
  assert.equal(fix.problem, null);
  assert.equal(env.HOME, home);
  assert.equal(describeHomeFix(fix), null, 'nothing to say when nothing changed');
});

test('ensureWritableHome: a HOME that does not exist is relocated to the temp dir', () => {
  const tmpDir = tmpDirFor('fallback-missing');
  const env: NodeJS.ProcessEnv = { HOME: path.join(scratch, 'gone', 'gone') };
  const fix = ensureWritableHome({ env, tmpDir, accountHome: null });
  assert.equal(fix.changed, true);
  assert.equal(fix.error, null);
  assert.equal(fix.problem, 'does not exist');
  assert.ok(fix.home?.startsWith(tmpDir), `expected a home under ${tmpDir}, got ${fix.home}`);
  assert.equal(env.HOME, fix.home, 'the variable DuckDB reads is the one we set');
  // The point of the exercise: DuckDB can create its extension store there.
  fs.mkdirSync(path.join(fix.home!, '.duckdb', 'extensions'), { recursive: true });
  assert.equal(homeDirProblem(fix.home), null);
  assert.match(describeHomeFix(fix) ?? '', /HOME/);
});

test('ensureWritableHome: a read-only HOME is relocated', { skip: asRoot }, () => {
  const home = tmpDirFor('frozen');
  fs.chmodSync(home, 0o500);
  const tmpDir = tmpDirFor('fallback-frozen');
  const env: NodeJS.ProcessEnv = { HOME: home };
  try {
    const fix = ensureWritableHome({ env, tmpDir, accountHome: null });
    assert.equal(fix.changed, true);
    assert.match(fix.problem ?? '', /is not writable/);
    assert.ok(fix.home?.startsWith(tmpDir));
    assert.equal(env.HOME, fix.home);
  } finally {
    fs.chmodSync(home, 0o700);
  }
});

test('ensureWritableHome: an unset HOME always ends up set', () => {
  const tmpDir = tmpDirFor('fallback-unset');
  const env: NodeJS.ProcessEnv = {};
  const fix = ensureWritableHome({ env, tmpDir, accountHome: null });
  assert.equal(fix.previous, null);
  assert.equal(fix.problem, 'is not set');
  assert.equal(fix.changed, true);
  assert.ok(env.HOME, 'DuckDB reads getenv("HOME") — it must be set, not merely derivable');
  assert.equal(homeDirProblem(env.HOME), null);
});

test('ensureWritableHome: nothing is changed when no fallback can be made', () => {
  const home = path.join(scratch, 'still-gone');
  const env: NodeJS.ProcessEnv = { HOME: home };
  // A file where the fallback's parent directory would have to be: mkdir fails.
  const blocked = path.join(scratch, 'blocked-tmp');
  fs.writeFileSync(blocked, '');
  const fix = ensureWritableHome({ env, tmpDir: blocked, accountHome: null });
  assert.equal(fix.changed, false);
  assert.ok(fix.error, 'the failure is reported, not swallowed');
  assert.equal(env.HOME, home, 'the environment is left as we found it');
  assert.match(describeHomeFix(fix) ?? '', /writable/);
});

test("ensureWritableHome: the account's real home wins over the temp dir", () => {
  // HOME merely wasn't exported (a daemon, a `docker exec` without -e HOME).
  // The account still has a home, and it may already hold an extension cache.
  const account = tmpDirFor('account-home');
  const tmpDir = tmpDirFor('fallback-unused');
  const env: NodeJS.ProcessEnv = {};
  const fix = ensureWritableHome({ env, tmpDir, accountHome: account });
  assert.equal(fix.changed, true);
  assert.equal(fix.home, account);
  assert.equal(env.HOME, account);
});

test('ensureWritableHome: the process-wide call is memoized', () => {
  const first = ensureWritableHome();
  const second = ensureWritableHome();
  assert.equal(first, second, 'every entry point asks; the answer cannot change');
});

// ---------------------------------------------------------------------------
// The failure itself, end to end: a child process with a broken HOME opens a
// real Malloy DuckDB connection. The first test reproduces the bug (and says so
// if DuckDB ever stops caring about HOME); the second is the same run with the
// fix in front of it. Neither needs the network — the home lookup happens
// before any extension download.
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(HERE, 'fixtures', 'home-probe.mts');

interface ProbeRun {
  status: number | null;
  stdout: string;
  stderr: string;
  /** HOME the child ended up with, as it reported it. */
  home: string;
  /** The home it was started with — missing, and unwritable to create. */
  broken: string;
}

/** Run the probe with a HOME that does not exist. `fix` calls
    ensureWritableHome() first; `raw` hands DuckDB the broken value. */
function probe(mode: 'raw' | 'fix'): ProbeRun {
  const broken = path.join(scratch, 'no-such-home', 'nested');
  const r = spawnSync(
    process.execPath,
    ['--import', 'tsx', PROBE, ...(mode === 'fix' ? ['fix'] : [])],
    {
      cwd: path.join(HERE, '..'),
      encoding: 'utf8',
      // TMPDIR steers os.tmpdir(), so the fallback home lands in the scratch
      // dir with everything else this file creates.
      env: { ...process.env, HOME: broken, TMPDIR: tmpDirFor('probe-tmp') },
    },
  );
  const stdout = r.stdout ?? '';
  return {
    status: r.status,
    stdout,
    stderr: r.stderr ?? '',
    home: (/^HOME (.*)$/m.exec(stdout)?.[1] ?? '').trim(),
    broken,
  };
}

test('reproduction: a home directory that does not exist breaks DuckDB extensions', () => {
  const r = probe('raw');
  assert.equal(r.home, r.broken, 'precondition: the child kept the broken HOME');
  // DuckDB's own words, and the whole problem: httpfs never loads, so every
  // model reading an https:// or s3:// source fails later for no visible reason.
  assert.match(r.stderr, /home directory/i);
  assert.match(r.stderr, /Unable to load DuckDB extension/i);
});

test('…and does not, once ensureWritableHome has run', () => {
  const r = probe('fix');
  assert.equal(r.status, 0, `expected the probe to succeed, got:\n${r.stderr}`);
  assert.notEqual(r.home, r.broken, 'HOME was relocated');
  assert.doesNotMatch(r.stderr, /home directory/i, `still complaining:\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /Unable to load DuckDB extension "(json|icu)"/i);
  // DuckDB got far enough to create its extension store where we pointed it.
  assert.ok(
    fs.existsSync(path.join(r.home, '.duckdb')),
    `expected DuckDB's store at ${path.join(r.home, '.duckdb')}`,
  );
});
