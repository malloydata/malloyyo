// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The resident compiler.
//
// A CLI invocation spends ~320ms on startup — loading the bundle, then Malloy's
// first-compile warmup — to do 3-5ms of actual work, and throws all of it away
// on exit. An agent working out a query runs ten or so commands in a row
// (describe_source, query, yo_help, query again…) and pays that ten times.
//
// So: keep one process alive holding the rehydrated model, and let subsequent
// invocations hand it a command over a unix socket. The first call is unchanged
// — it does its own work in-process and forks a daemon on the way out, so it
// never waits for one — and every call after it is a socket round trip plus a
// 3-5ms compile.
//
// Three failure modes get designed out rather than handled:
//   staleness  the socket NAME contains a hash of the model file's path, size
//              and mtime, so an edited model cannot reach an old daemon — it
//              simply addresses a different socket.
//   leaks      the daemon exits on its own after an idle period. Nothing has to
//              remember to stop it.
//   races      two clients starting at once both try to listen; the loser gets
//              EADDRINUSE and connects to the winner instead.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createConnection, createServer, type Socket } from 'node:net';
import { statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * How long a daemon sits idle before exiting.
 *
 * Two minutes, chosen against a measured cost: a daemon holding a rehydrated
 * model plus the Malloy compiler is ~100MB resident. One is a fine trade for a
 * 6x speedup; a dozen left over from a morning's work across several models is
 * a gigabyte of nothing. The downside of expiring early is small and
 * self-correcting — the next call pays a normal cold start and forks a fresh
 * one — so this errs short.
 */
export const IDLE_MS = Number(process.env['MALLOYYO_DAEMON_IDLE_MS'] ?? 120_000);

/** The command a spawned daemon is started with (internal, not user-facing). */
export const SERVE_COMMAND = '__serve';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Run one parsed command. The daemon and the direct path share this exactly,
    so a result cannot depend on which one produced it. */
export type CommandRunner = (argv: string[]) => Promise<CommandResult>;

/**
 * Address of the daemon for one model file. Includes the model's identity, so
 * editing or replacing the file addresses a different daemon instead of reusing
 * a stale one, and the uid, so two users never share a socket.
 */
export function socketPathFor(modelFile: string): string {
  const resolved = path.resolve(modelFile);
  let stamp = 'missing';
  try {
    const st = statSync(resolved);
    stamp = `${st.size}:${st.mtimeMs}`;
  } catch {
    /* a missing file fails later, with a better message than this could give */
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const key = createHash('sha256').update(`${uid}\0${resolved}\0${stamp}`).digest('hex').slice(0, 16);
  // Windows has no unix sockets; its named pipes live in a virtual namespace.
  if (process.platform === 'win32') return `\\\\.\\pipe\\malloyyo-client-${key}`;
  return path.join(process.env['XDG_RUNTIME_DIR'] || tmpdir(), `malloyyo-client-${key}.sock`);
}

// ── wire format: one JSON object per line, request and response ──────

function sendLine(sock: Socket, value: unknown): void {
  sock.write(JSON.stringify(value) + '\n');
}

/** Read newline-delimited JSON off a socket, one object at a time. */
function onLines(sock: Socket, fn: (value: unknown) => void): void {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        fn(JSON.parse(line));
      } catch {
        /* a malformed line is the peer's problem; ignore it rather than die */
      }
    }
  });
}

/**
 * Ask a running daemon to run a command. Resolves `null` when there is no
 * daemon (or it is not answering), which is a normal outcome, not an error —
 * the caller then does the work itself.
 */
export function askDaemon(
  socketPath: string,
  argv: string[],
  timeoutMs = 5_000,
): Promise<CommandResult | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: CommandResult | null): void => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* already gone */ }
      resolve(v);
    };
    const sock = createConnection(socketPath);
    sock.setTimeout(timeoutMs, () => done(null));
    sock.on('error', () => done(null)); // no daemon, or a stale socket file
    sock.on('close', () => done(null)); // closed before answering
    sock.on('connect', () => sendLine(sock, { argv }));
    onLines(sock, (msg) => {
      const r = msg as Partial<CommandResult>;
      if (typeof r.exitCode !== 'number') return done(null);
      done({ stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode });
    });
  });
}

/**
 * Fork a detached daemon for this model and return immediately. Fire-and-forget
 * on purpose: the caller has already done its own work, and a daemon that fails
 * to start must cost nothing but the next invocation's normal startup.
 */
export function spawnDaemon(modelFile: string, extraArgs: string[] = []): void {
  const entry = process.argv[1];
  if (!entry) return;
  try {
    const child = spawn(
      process.execPath,
      [entry, SERVE_COMMAND, '--model', modelFile, ...extraArgs],
      { detached: true, stdio: 'ignore', env: process.env },
    );
    child.on('error', () => { /* no daemon; every call just stays slow */ });
    child.unref();
  } catch {
    /* same */
  }
}

/**
 * Run the daemon: listen on the model's socket and serve commands until idle.
 * Resolves when the server stops, so the caller can exit cleanly.
 */
export function serve(socketPath: string, run: CommandRunner, idleMs = IDLE_MS): Promise<void> {
  return new Promise((resolve) => {
    const server = createServer();
    let idle: NodeJS.Timeout | undefined;
    let inFlight = 0;

    const stop = (): void => {
      server.close(() => resolve());
      // A hung connection must not keep the process alive past its welcome.
      setTimeout(() => resolve(), 1_000).unref();
    };
    const resetIdle = (): void => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => { if (inFlight === 0) stop(); }, idleMs);
      idle.unref();
    };

    server.on('connection', (sock) => {
      resetIdle();
      sock.on('error', () => { /* peer vanished mid-request */ });
      onLines(sock, (msg) => {
        const argv = (msg as { argv?: unknown }).argv;
        if (!Array.isArray(argv)) return;
        inFlight++;
        void run(argv as string[])
          .then(
            (r) => sendLine(sock, r),
            (e: unknown) => sendLine(sock, {
              stdout: '',
              stderr: `malloyyo_client: ${e instanceof Error ? e.message : String(e)}\n`,
              exitCode: 2,
            }),
          )
          .finally(() => {
            inFlight--;
            resetIdle();
            sock.end();
          });
      });
    });

    server.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') {
        // Either another daemon won the race — fine, it serves everyone — or a
        // dead one left its socket file behind. Tell them apart by connecting.
        const probe = createConnection(socketPath);
        probe.on('connect', () => { probe.destroy(); resolve(); });
        probe.on('error', () => {
          probe.destroy();
          try { unlinkSync(socketPath); } catch { /* someone else got there first */ }
          server.listen(socketPath);
        });
        return;
      }
      resolve(); // any other listen failure: no daemon, callers stay on the slow path
    });

    // Leave no socket file behind on ANY exit — including the abrupt one from
    // `daemon stop`. A leftover file is what the next client mistakes for a
    // live daemon, and it then pays a failed connect before falling through.
    const cleanup = (): void => {
      if (process.platform === 'win32') return; // named pipes are not files
      try { unlinkSync(socketPath); } catch { /* already gone */ }
    };
    process.once('exit', cleanup);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.once(sig, () => { cleanup(); process.exit(0); });
    }

    server.listen(socketPath, () => resetIdle());
  });
}
