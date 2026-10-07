// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * "You are running an old malloyyo."
 *
 * This exists because of how the dev container ages. The image installs the CLI
 * unpinned, so it bakes whatever npm called latest at BUILD time, and the image
 * is republished only on `workflow_dispatch` — while `cli-publish.yml` releases
 * on every push to main. A container that was current when it was built is one
 * release behind by the next merge, and eleven behind a month later. That
 * happened: a codespace was running 0.2.46 against an instance on 0.2.57, and
 * the way anyone found out was by reading a version string and then a
 * Dockerfile. The CLI knows its own version and npm will say what the latest
 * is; it should simply mention it.
 *
 * Three rules, and they are the whole design:
 *
 *  1. NEVER make a command wait on the network. The check runs in a detached
 *     child that this process does not wait for; the current run prints only
 *     what a PREVIOUS run already cached. A first-ever run says nothing, which
 *     is correct — it has nothing to say yet.
 *  2. NEVER write to stdout. `malloyyo mcp` speaks JSON-RPC there and `malloyyo
 *     sql` is piped; one stray line corrupts both. The notice goes to stderr,
 *     and not at all for the commands below.
 *  3. NEVER fail. Every path is wrapped: no cache dir, no network, unreadable
 *     JSON, a registry that answers HTML — all of it ends in silence rather
 *     than in an error on top of whatever the person actually ran.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { version as VERSION } from "../package.json";

/** The argv the detached child is spawned with. Underscored and undocumented:
    it is not a command anybody should type, and `commander` would otherwise
    advertise it in `--help`. */
export const UPDATE_CHECK_ARGV = "__update-check";

const PKG = "@malloydata/malloyyo";

/** How long a fetched answer is trusted before the child goes again. */
const CHECK_INTERVAL_MS = 1000 * 60 * 60 * 24; // 1 day
/** How long after mentioning it we may mention it again. Deliberately longer
    than CHECK_INTERVAL: knowing about a new version and being willing to say so
    are separate questions, and conflating them is what makes update notices
    the thing people set an env var to silence. */
const NOTIFY_INTERVAL_MS = 1000 * 60 * 60 * 24 * 3; // 3 days
/** A registry that does not answer promptly is a registry we ignore. The child
    is detached, so this only bounds how long a stray process lingers. */
const FETCH_TIMEOUT_MS = 3000;

/** Commands whose output is consumed by a program, not read by a person. */
const QUIET_COMMANDS = new Set(["mcp", "sql", UPDATE_CHECK_ARGV]);

type Cache = {
  /** The version the registry last reported for the `latest` tag. */
  latest?: string;
  /** When that was fetched — the child refreshes once this is CHECK_INTERVAL old. */
  checkedAt?: number;
  /** When we last printed the notice. */
  notifiedAt?: number;
};

/** The per-user cache directory, by platform convention and with no dependency.
    Falls back to the temp dir rather than giving up: a lost cache costs one
    extra check, while throwing here would cost the command. */
function cacheDir(): string {
  const home = homedir();
  if (process.env.MALLOYYO_CACHE_DIR) return process.env.MALLOYYO_CACHE_DIR;
  if (process.platform === "darwin") return join(home, "Library", "Caches", "malloyyo");
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "malloyyo", "Cache");
  }
  return join(process.env.XDG_CACHE_HOME || join(home, ".cache"), "malloyyo");
}

function cacheFile(): string {
  try {
    const dir = cacheDir();
    mkdirSync(dir, { recursive: true });
    return join(dir, "update-check.json");
  } catch {
    return join(tmpdir(), "malloyyo-update-check.json");
  }
}

function readCache(file: string): Cache {
  try {
    const raw = readFileSync(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Cache) : {};
  } catch {
    return {};
  }
}

function writeCache(file: string, cache: Cache): void {
  try {
    writeFileSync(file, JSON.stringify(cache));
  } catch {
    /* a cache we cannot write is a check we repeat; not worth a word */
  }
}

/**
 * Is `latest` ahead of `current`?
 *
 * Numeric dot segments of the RELEASE part only: anything from the first `-` or
 * `+` is dropped before splitting. That truncation is the whole subtlety, and
 * the first version of this got it wrong — `"0.2.58-beta.1".split(".")` is
 * `["0","2","58-beta","1"]`, which parses to `[0,2,58,1]` and therefore compares
 * NEWER than `0.2.58`. A prerelease on the `latest` tag would then have told
 * everyone on the stable release to upgrade to a beta. The test for it is in
 * test/update-check.test.ts and it failed on the first run.
 *
 * Written out rather than taking a semver dependency for one comparison. The
 * mistake that matters is answering yes when it should be no, because the
 * failure mode is a confident wrong sentence.
 */
export function isNewer(latest: string, current: string): boolean {
  const seg = (v: string) =>
    (v.split(/[-+]/)[0] ?? "").split(".").map((p) => Number.parseInt(p, 10) || 0);
  const a = seg(latest);
  const b = seg(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const l = a[i] ?? 0;
    const r = b[i] ?? 0;
    if (l !== r) return l > r;
  }
  return false;
}

/** This bundle's own path, so the child can be *this* CLI rather than a script
    beside it. The CLI ships as one esbuild bundle, so there is no separate
    worker file to spawn — the detached child is `node <this bundle>
    __update-check`, which is why that argv exists at all. */
function selfPath(): string | null {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return null;
  }
}

/** Start the check and do not wait for it. `detached` + `unref` so this process
    can exit immediately; `stdio: "ignore"` so the child cannot write onto the
    terminal after the command has finished and confuse whoever is reading it. */
function spawnCheck(): void {
  try {
    const self = selfPath();
    if (!self || !existsSync(self)) return;
    const child = spawn(process.execPath, [self, UPDATE_CHECK_ARGV], {
      detached: true,
      stdio: "ignore",
      cwd: dirname(self),
      env: { ...process.env, MALLOYYO_NO_UPDATE_CHECK: "1" },
    });
    child.unref();
  } catch {
    /* no child, no check, no complaint */
  }
}

/**
 * The detached child's whole job: ask npm, write the file, exit.
 *
 * Only the `dist-tags` document, which is a few bytes, rather than the package
 * metadata, which for this package is large enough to notice.
 */
export async function runUpdateCheck(): Promise<void> {
  const file = cacheFile();
  const cache = readCache(file);
  try {
    const res = await fetch(`https://registry.npmjs.org/-/package/${PKG}/dist-tags`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return;
    const tags = (await res.json()) as Record<string, string> | null;
    const latest = tags?.latest;
    if (typeof latest !== "string" || latest === "") return;
    // checkedAt moves even when the version has not: it records that we ASKED,
    // which is what stops a run-per-command storm against the registry.
    writeCache(file, { ...cache, latest, checkedAt: Date.now() });
  } catch {
    // A failed fetch still counts as having asked — otherwise an offline
    // machine spawns a child for every single command, forever.
    writeCache(file, { ...cache, checkedAt: Date.now() });
  }
}

/**
 * Print the notice if one is due, and start a refresh if the cache is stale.
 *
 * Called once, for its side effects, and registered to run on `exit` so the
 * line lands AFTER the command's own output instead of scrolling away above it.
 * Everything here is synchronous for that reason — an exit handler cannot wait.
 */
export function noticeOnExit(argv: readonly string[]): void {
  if (process.env.MALLOYYO_NO_UPDATE_CHECK) return;
  // `CI` is set by every major runner. A notice nobody reads, in a log nobody
  // greps, is only a reason for the next person to pin an old version.
  if (process.env.CI) return;
  const command = argv[2];
  if (command && QUIET_COMMANDS.has(command)) return;

  const file = cacheFile();
  const cache = readCache(file);

  // Stale or absent: ask in the background. Says nothing THIS run, by design.
  if (!cache.checkedAt || Date.now() - cache.checkedAt > CHECK_INTERVAL_MS) spawnCheck();

  if (!cache.latest || !isNewer(cache.latest, VERSION)) return;
  if (cache.notifiedAt && Date.now() - cache.notifiedAt < NOTIFY_INTERVAL_MS) return;

  process.on("exit", () => {
    try {
      // Written before printing: if the print throws on a closed stream, the
      // alternative is repeating the notice on every command.
      writeCache(file, { ...cache, notifiedAt: Date.now() });
      process.stderr.write(
        `\nmalloyyo ${VERSION} — ${cache.latest} is available.\n` +
          `  npm i -g ${PKG}@latest\n` +
          `  (in a dev container this needs no sudo; set MALLOYYO_NO_UPDATE_CHECK=1 to silence)\n`,
      );
    } catch {
      /* the command already succeeded; this is the least important line */
    }
  });
}
