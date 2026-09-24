// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Boot-migration outcome, bridged from instrumentation.ts to /api/health.
// Lives on globalThis because instrumentation and route handlers are compiled
// into separate bundles — a module-scope variable can be duplicated per
// bundle, and this flag must be the one thing both sides see.

export type MigrationOutcome = { ok: true } | { ok: false; error: string };

declare global {
  var __malloyyoMigrationOutcome__: MigrationOutcome | undefined;
}

export function recordMigrationOutcome(outcome: MigrationOutcome): void {
  globalThis.__malloyyoMigrationOutcome__ = outcome;
}

/**
 * Whether this instance applies the migration journal at boot.
 *
 * On by default in production — a deployment should never need a flag to get
 * a correct schema — and off by default in development, where `npm run dev`
 * is routinely pointed at a real instance's database via `local/<env>` files
 * and a working tree's unmerged journal entries must not leak into it.
 * `RUN_MIGRATIONS_ON_BOOT=0` (or `false`) always disables — for operators who
 * apply the journal out-of-band (scripts/run-boot-migrations.ts) or run the
 * app under a role without DDL rights; any other value always enables.
 */
export function bootMigrationsEnabled(): boolean {
  // Vercel Functions cannot complete this work reliably; the Vercel build owns it.
  // Check before the operator flag so a stale RUN_MIGRATIONS_ON_BOOT=1 cannot revive
  // the incident this platform-specific policy exists to prevent.
  if (process.env.VERCEL) return false;
  const v = process.env.RUN_MIGRATIONS_ON_BOOT?.trim().toLowerCase();
  if (v === "0" || v === "false") return false;
  if (v) return true;
  return process.env.NODE_ENV === "production";
}

/**
 * Why this instance is unready, or null if it is ready. Only instances that
 * run boot migrations can be unready: a migration failure — or migrations
 * somehow not having run at all — must fail readiness, so the hosted roll
 * gate (which probes /api/health on the new image before promoting it) never
 * routes traffic onto a half-migrated instance.
 */
export function migrationGateError(): string | null {
  if (!bootMigrationsEnabled()) return null;
  const outcome = globalThis.__malloyyoMigrationOutcome__;
  if (!outcome) return "boot migrations have not run";
  return outcome.ok ? null : outcome.error;
}
