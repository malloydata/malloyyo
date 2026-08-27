// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// A writable HOME, or DuckDB doesn't run.
//
// DuckDB keeps its extension store in `$HOME/.duckdb` and resolves it from the
// HOME environment variable itself (USERPROFILE on Windows) — not from the
// passwd database, and not from the process's working directory. So on a host
// where HOME is unset, points at a directory that doesn't exist, or points at
// one the process can't write, the first statement that autoloads an extension
// (httpfs for an https:// or s3:// source, json, parquet, spatial …) dies with
// something like:
//
//     IO Error: Failed to create directory "/home/app/.duckdb/extensions/…"
//     IO Error: Can't find the home directory at ''
//
// Nothing in that message says "set HOME", so the manual fix people land on is
// `HOME=/tmp malloyyo …`. That is what this does automatically.
//
// This is NOT a rare configuration:
//   - Kubernetes/OpenShift `runAsUser: <random uid>` — the uid has no passwd
//     entry, so HOME is unset or `/`, and `/` is not writable.
//   - `docker run --read-only`, or an image whose user's home was never created
//     (`USER 1001` without a matching `/home/…`).
//   - Serverless (Vercel/Lambda) — the whole filesystem is read-only but /tmp.
//   - Any daemon started from an environment that doesn't export HOME.
//
// The check is deliberately cheap (a stat and an access(2)) and runs before the
// DuckDB backend is loaded; the fallback is a private directory under the
// system temp dir rather than the temp root, so two users on one host don't
// fight over one `.duckdb`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** What `ensureWritableHome` found, and what it did about it. */
export interface HomeFix {
  /** HOME as the process was started with; null when it was unset or empty. */
  previous: string | null;
  /** The home directory in effect after the call, or null if we couldn't get
      a usable one (then `error` says why). */
  home: string | null;
  /** True when this call changed the environment. */
  changed: boolean;
  /** Why `previous` was rejected — null when it was already fine. */
  problem: string | null;
  /** Set only when `previous` was unusable AND the fallback failed too: the
      process is left exactly as it was, and DuckDB will fail on its own terms. */
  error: string | null;
}

/** Environment variables DuckDB reads for the home directory, most significant
    first. POSIX reads HOME; Windows reads USERPROFILE (and Node/most tooling
    honours HOME there too, so we keep both in step). */
const HOME_VARS = process.platform === 'win32' ? ['USERPROFILE', 'HOME'] : ['HOME'];

function errCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

/**
 * Why `dir` can't serve as DuckDB's home, or null when it can.
 *
 * Writable means writable *by this process*, established by actually writing:
 * `access(W_OK|X_OK)` rejects the common cases cheaply (EROFS on a read-only
 * mount, EACCES on someone else's directory) but only a real mkdir rules out a
 * full disk, a quota, or a mount that lies. When `.duckdb` already exists it
 * has to be writable too — a store created by root and then read by an
 * unprivileged user is a live case in containers that drop privileges.
 */
export function homeDirProblem(dir: string | null | undefined): string | null {
  if (!dir) return 'is not set';
  let st: fs.Stats;
  try {
    st = fs.statSync(dir);
  } catch (e) {
    return errCode(e) === 'ENOENT' ? 'does not exist' : `is unreadable (${errCode(e)})`;
  }
  if (!st.isDirectory()) return 'is not a directory';
  try {
    fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
  } catch (e) {
    return `is not writable (${errCode(e)})`;
  }
  // access(2) answers "would the permission bits allow it", which is not the
  // same question: a full filesystem, a quota, an overlay whose upper layer is
  // gone, an idmapped mount. Getting this wrong is worse than not checking —
  // we'd leave HOME pointing somewhere DuckDB then fails on — so make the
  // actual write DuckDB will make. The probe is a directory beside the
  // extension store, removed immediately.
  let probe: string | null = null;
  try {
    probe = fs.mkdtempSync(path.join(dir, '.duckdb-home-check-'));
  } catch (e) {
    return `is not writable (${errCode(e)})`;
  } finally {
    if (probe) {
      try {
        fs.rmdirSync(probe);
      } catch {
        /* best effort — an empty directory we couldn't remove doesn't change
           the answer, and leaving it beats failing the check */
      }
    }
  }
  // DuckDB's extension store. Absent is fine — it gets created in a directory
  // we just proved writable.
  const store = path.join(dir, '.duckdb');
  try {
    const dst = fs.statSync(store);
    if (!dst.isDirectory()) return `has a .duckdb that is not a directory`;
    fs.accessSync(store, fs.constants.W_OK | fs.constants.X_OK);
  } catch (e) {
    if (errCode(e) !== 'ENOENT') return `has a .duckdb this process can't write (${errCode(e)})`;
  }
  return null;
}

/** The account's home as the passwd database (not the environment) reports it.
    `os.homedir()` prefers $HOME when it is set, so this is only consulted when
    the variable is missing or broken — and it throws for a uid with no passwd
    entry, which is one of the ways HOME goes missing in the first place. */
function passwdHome(): string | null {
  try {
    const dir = os.userInfo().homedir;
    return dir && dir.length > 0 ? dir : null;
  } catch {
    return null;
  }
}

/** Per-user so a shared /tmp doesn't hand user B a 0700 directory owned by A. */
function fallbackHome(tmpDir: string): string {
  let uid: number | undefined;
  try {
    uid = os.userInfo().uid;
  } catch {
    /* no passwd entry — the very case that breaks HOME in the first place */
  }
  const suffix = typeof uid === 'number' && uid >= 0 ? `-${uid}` : '';
  return path.join(tmpDir, `malloyyo-home${suffix}`);
}

export interface EnsureHomeOptions {
  /** The environment to inspect and mutate. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Where the fallback home is created. Defaults to `os.tmpdir()`. */
  tmpDir?: string;
  /** The account's home per the passwd database, preferred over the temp dir
      when HOME itself is unusable. Defaults to `passwdHome()`; pass null to
      rule it out (tests, and callers that want the temp dir regardless). */
  accountHome?: string | null;
}

/** Memoized result of the no-argument call — every entry point that touches a
    connection asks, and the answer can't change within a process. */
let cached: HomeFix | null = null;

/**
 * Make sure DuckDB has a home directory it can write, relocating HOME to a
 * private directory under the system temp dir when it doesn't.
 *
 * Call this BEFORE the DuckDB backend loads or any connection is opened —
 * DuckDB reads the variable when it resolves the extension path, so setting it
 * early is enough and no connection needs to know about it.
 *
 * Returns what it found so the caller can log it; it never throws, and when it
 * can't fix things it changes nothing and reports why in `error`.
 */
export function ensureWritableHome(opts: EnsureHomeOptions = {}): HomeFix {
  const memoize =
    opts.env === undefined && opts.tmpDir === undefined && opts.accountHome === undefined;
  if (memoize && cached) return cached;

  const env = opts.env ?? process.env;
  const tmpDir = opts.tmpDir ?? os.tmpdir();

  const current = HOME_VARS.map((v) => env[v]).find((v) => v && v.length > 0) ?? null;
  const problem = homeDirProblem(current);

  const apply = (home: string): void => {
    for (const v of HOME_VARS) env[v] = home;
  };

  let fix: HomeFix;
  if (!problem) {
    // Usable — but if it came from USERPROFILE alone (Windows) make sure every
    // variable in the set agrees, so nothing downstream reads a different one.
    const stale = HOME_VARS.some((v) => env[v] !== current);
    if (stale) apply(current as string);
    fix = { previous: current, home: current, changed: stale, problem: null, error: null };
  } else {
    // The account's real home, when the variable simply wasn't exported (a
    // daemon started without HOME, a `docker exec` without -e HOME). Preferred
    // over the temp dir: it's where an extension cache may already live.
    const passwd = opts.accountHome === undefined ? passwdHome() : opts.accountHome;
    const candidate = passwd && passwd !== current && !homeDirProblem(passwd) ? passwd : null;
    if (candidate) {
      apply(candidate);
      fix = { previous: current, home: candidate, changed: true, problem, error: null };
    } else {
      const fallback = fallbackHome(tmpDir);
      let error: string | null = null;
      try {
        fs.mkdirSync(fallback, { recursive: true, mode: 0o700 });
        error = homeDirProblem(fallback);
      } catch (e) {
        error = `could not be created (${errCode(e)})`;
      }
      if (error) {
        fix = {
          previous: current,
          home: current,
          changed: false,
          problem,
          error: `HOME ${problem}, and the fallback ${fallback} ${error}`,
        };
      } else {
        apply(fallback);
        fix = { previous: current, home: fallback, changed: true, problem, error: null };
      }
    }
  }

  if (memoize) cached = fix;
  return fix;
}

/**
 * One line for a log/stderr, or null when there is nothing worth saying (the
 * common case: HOME was already fine). Shared so the CLI and the server explain
 * this the same way.
 */
export function describeHomeFix(fix: HomeFix): string | null {
  const was = fix.previous ? `HOME=${fix.previous}` : 'HOME (unset)';
  if (fix.error) {
    return (
      `${was} ${fix.problem}, and no writable fallback was available — ${fix.error}. ` +
      `DuckDB stores its extensions in $HOME/.duckdb and will fail to load them. ` +
      `Set HOME to a writable directory (e.g. HOME=/tmp).`
    );
  }
  if (!fix.changed) return null;
  return (
    `${was} ${fix.problem ?? 'needed normalizing'}; using HOME=${fix.home} for this process. ` +
    `DuckDB needs a writable home directory for its extension store ($HOME/.duckdb).`
  );
}

/** Test-only: forget the memoized result of a no-argument call. */
export function resetWritableHomeCache(): void {
  cached = null;
}
