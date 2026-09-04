// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

type BuildEnvironment = Readonly<Record<string, string | undefined>>;

export interface VercelBuildSteps {
  readonly build: () => Promise<void>;
  readonly migrate: () => Promise<void>;
  readonly environment?: BuildEnvironment;
}

function explicitMigrationSetting(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "") return undefined;
  if (normalized === "1" || normalized === "true") return true;
  if (normalized === "0" || normalized === "false") return false;
  throw new Error("RUN_MIGRATIONS_ON_BUILD must be 1, true, 0, or false");
}

/**
 * Production Vercel builds migrate by default. Preview and custom environments do not:
 * they may share Production's DATABASE_URL, and an unmerged branch must never advance
 * that database merely because Vercel built it. An operator with an isolated database
 * can opt that environment in explicitly.
 */
export function vercelBuildMigrationsEnabled(environment: BuildEnvironment): boolean {
  const explicit = explicitMigrationSetting(environment.RUN_MIGRATIONS_ON_BUILD);
  if (explicit !== undefined) return explicit;
  return environment.VERCEL_ENV === "production";
}

/**
 * Build before touching the database, then migrate before Vercel can publish the build.
 * A failed application build performs no schema mutation; a failed migration rejects the
 * whole Vercel build and therefore cannot be promoted.
 */
export async function runVercelBuild(steps: VercelBuildSteps): Promise<void> {
  const shouldMigrate = vercelBuildMigrationsEnabled(steps.environment ?? process.env);
  await steps.build();
  if (shouldMigrate) await steps.migrate();
}
