// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Next.js calls register() once when the server starts. We use it to
// self-initialize the database schema on a fresh one-click deploy.
//
// Off by default — only runs when RUN_MIGRATIONS_ON_BOOT is set, so the managed
// instances (main / staging / motherduckyo) keep their hand-run psql migration
// workflow and this never touches them. The one-click Deploy button sets the flag.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.RUN_MIGRATIONS_ON_BOOT) return;

  // Dynamic import so postgres/the baseline aren't pulled into non-nodejs runtimes.
  const { ensureSchema } = await import("@/lib/migrate");
  try {
    await ensureSchema();
  } catch {
    // ensureSchema already logged; don't crash startup. A genuinely broken DB
    // will surface as request-time errors, which are easier to diagnose.
  }
}
