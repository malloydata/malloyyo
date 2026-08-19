// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Fail-fast configuration checks, run once at server start from
// instrumentation.ts.
//
// This lives in its own module for a compile-time reason, not a tidiness one.
// `instrumentation.ts` is compiled for BOTH the nodejs and edge runtimes, and
// the edge compile rejects Node APIs — `process.exit` produces "A Node.js API
// is used (process.exit) which is not supported in the Edge Runtime" and an
// "Ecmascript file had an error". The runtime guard in register() does not help:
// it runs after compilation. Keeping the Node API behind a dynamic import that
// only the nodejs branch reaches is the same pattern the file already uses for
// `@/lib/migrate` and its native postgres dependency.

import { baseUrlStartupError } from "@/lib/oauth/base-url";

/** Exit rather than throw: Next logs an error thrown from register() and then
    carries on serving, which is the opposite of what a fail-fast check is for. */
export function assertStartupConfig(): void {
  const configError = baseUrlStartupError();
  if (configError) {
    console.error(`\n[startup] ${configError}\n`);
    process.exit(1);
  }
}
