// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Next.js calls register() once when the server starts, and it must complete
// before the server answers requests. We use it to apply the drizzle/ journal
// (drizzle-orm's runtime migrator) — a fresh database initializes, an existing
// one upgrades, and a failure fails readiness via /api/health.
//
// On by default in production, off by default in development, and
// RUN_MIGRATIONS_ON_BOOT=0 always disables — see bootMigrationsEnabled(). A
// deployment needs no flag to get a correct schema; a dev server pointed at a
// real database via local/<env> never mutates it uninvited.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Refuse to serve a misconfigured instance rather than serving one that
  // advertises whatever origin a caller asks it to. Scoped to the deployments
  // where the fronting proxy is untrusted — see baseUrlStartupError().
  //
  // Dynamically imported, like runMigrations below: the check calls process.exit,
  // which the EDGE compile of this file rejects outright even though the guard
  // above means it never runs there. See @/lib/startup.
  const { assertStartupConfig } = await import("@/lib/startup");
  assertStartupConfig();

  const { bootMigrationsEnabled, recordMigrationOutcome } = await import("@/lib/migration-state");
  if (bootMigrationsEnabled()) {
    // Dynamic import so postgres/drizzle aren't pulled into non-nodejs runtimes.
    const { runMigrations } = await import("@/lib/migrate");
    try {
      await runMigrations();
      recordMigrationOutcome({ ok: true });
    } catch (err) {
      // runMigrations already logged the details. Record the failure instead of
      // crashing: the instance keeps serving so /api/health can report unready
      // (503) — the hosted roll gate and one-click deploys get a diagnosable
      // endpoint instead of a restart loop, and no request path trusts a
      // half-migrated schema behind a green health check.
      recordMigrationOutcome({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Membership warnings (a set-but-retired EMAIL_ALLOW_LIST; an 'open' policy
  // with sign-in enabled). After migrations so they read the upgraded schema;
  // best-effort — and independent of the migration gate, because a deployment
  // managing its schema out-of-band still wants to hear that its allow-list
  // is no longer read.
  try {
    const { logAccessWarnings } = await import("@/lib/access-warnings");
    await logAccessWarnings();
  } catch {
    // Nothing — request-time errors will say more than this could.
  }
}
