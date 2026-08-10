// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The thin front end — the actual `malloyyo_client` binary.
//
// It exists because "ask the daemon instead of compiling" saves nothing if you
// load a 4.2MB bundle containing the entire Malloy compiler in order to ask.
// Doing exactly that cost 250ms against the daemon's 3-5ms of real work; the
// bundle load WAS the remaining time. So this file talks to the daemon using
// nothing but Node builtins, and only falls through to the fat bundle when
// there is no daemon to answer — where the cost is the compile anyway.
//
// It is deliberately incurious: it understands just enough argv to find the
// model file and notice the flags that must bypass the fast path. Anything it
// is unsure about falls through to main.cjs, which parses argv properly. A
// wrong guess here would be a correctness bug; falling through is only slow.

import { askDaemon, socketPathFor, SERVE_COMMAND } from './daemon.js';

/** Commands that must not be answered by a daemon (or have no model at all). */
const NOT_FAST_PATH = new Set([SERVE_COMMAND, 'daemon']);

interface Peek {
  model?: string;
  command?: string;
  fastPathOk: boolean;
}

/** A minimal argv scan: enough to address a daemon, and no more. */
function peek(argv: string[]): Peek {
  const out: Peek = { fastPathOk: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-m' || a === '--model') { out.model = argv[++i]; continue; }
    if (a.startsWith('--model=')) { out.model = a.slice('--model='.length); continue; }
    if (a === '--no-daemon' || a === '-h' || a === '--help' || a === '-v' || a === '--version') {
      out.fastPathOk = false;
      continue;
    }
    if (!a.startsWith('-') && out.command === undefined) out.command = a;
  }
  if (process.env['MALLOYYO_NO_DAEMON'] === '1') out.fastPathOk = false;
  out.model ??= process.env['MALLOYYO_MODEL'];
  if (!out.model || !out.command || NOT_FAST_PATH.has(out.command)) out.fastPathOk = false;
  return out;
}

// Both require() calls below are the point of this file, not an oversight: the
// heavy bundle must load LAZILY, only once we know no daemon will answer. A
// static import would load 4.2MB of Malloy before we could ask, which is
// exactly the cost the daemon exists to avoid.
/* eslint-disable @typescript-eslint/no-require-imports */
function fallThrough(): void {
  // Enable V8's compile cache before the heavy require — it only applies to
  // modules compiled after the call, so it cannot live inside main.cjs.
  // Best-effort: Node 22.1+, and a read-only or full cache directory must
  // degrade to "slower", never "broken".
  try {
    (require('node:module') as { enableCompileCache?: () => void }).enableCompileCache?.();
  } catch {
    /* older Node, or an unwritable cache dir */
  }
  require('./main.cjs');
}
/* eslint-enable @typescript-eslint/no-require-imports */

const argv = process.argv.slice(2);
const p = peek(argv);

if (!p.fastPathOk) {
  fallThrough();
} else {
  askDaemon(socketPathFor(p.model!), argv).then(
    (hit) => {
      if (!hit) return fallThrough();
      process.stdout.write(hit.stdout);
      if (hit.stderr) process.stderr.write(hit.stderr);
      process.exitCode = hit.exitCode;
    },
    () => fallThrough(),
  );
}
