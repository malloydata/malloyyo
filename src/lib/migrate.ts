// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { seedAccessControl } from "./access-upgrade";
import { env } from "./env";
import { logger, serializeErr } from "./logger";

// Serializes concurrent boots (e.g. a warm and a spare Machine starting on the
// same image): drizzle's migrator reads the applied-migrations table OUTSIDE
// the transaction it applies migrations in, so two unserialized runs can both
// see the same pending set and both apply it. Session-level lock, released in
// the same session that took it. Key is arbitrary but fixed ('malloyyo' as a
// 64-bit int).
const MIGRATION_LOCK_KEY = "7881702495259687279";

let ran = false;

// Migrations must run against a real Postgres session: the advisory lock and
// `SET search_path` are session state, which PgBouncer in transaction mode
// (Neon's `-pooler` endpoint) silently drops between statements. Neon's own
// guidance for migrations is the direct endpoint — derive it by stripping the
// `-pooler` host suffix. Also strip the Neon-proxy param the postgres client
// would reject (same reason as cleanDatabaseUrl in src/db/index.ts).
function directDatabaseUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hostname = u.hostname.replace("-pooler.", ".");
    u.searchParams.delete("uselibpqcompat");
    return u.toString();
  } catch {
    return url;
  }
}

type JournalEntry = { idx: number; when: number; tag: string };

/**
 * Bring the database to the current schema by applying the drizzle/ journal
 * with drizzle-orm's runtime migrator. Fresh databases replay the whole
 * journal; existing ones get only what is pending. Gated by
 * RUN_MIGRATIONS_ON_BOOT (see instrumentation.ts): one-click deploys and
 * hosted tenant images set it; a failure here must fail readiness
 * (/api/health), never be swallowed.
 *
 * A pre-journal database — initialized by the retired ensureSchema baseline
 * applier, or migrated by hand before the journal became the boot path — is
 * baselined in place: entry 0000 is recorded as applied (its tables predate
 * the journal), and every later entry is written to converge on any vintage,
 * so migrate() upgrades from there.
 */
export async function runMigrations(): Promise<void> {
  if (ran) return;
  ran = true;

  const url = process.env.DATABASE_URL;
  if (!url) {
    // Under RUN_MIGRATIONS_ON_BOOT a missing DATABASE_URL is a config failure;
    // fail readiness rather than serving an uninitialized instance.
    throw new Error("runMigrations: DATABASE_URL is not set");
  }

  const migrationsFolder = path.join(process.cwd(), "drizzle");
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  if (!existsSync(journalPath)) {
    // The journal ships with the app (outputFileTracingIncludes "/**" traces
    // ./drizzle into the standalone/serverless bundle). Missing means a
    // packaging regression — fail loudly, never silently skip.
    throw new Error(`runMigrations: no migration journal at ${journalPath}`);
  }

  const sql = postgres(directDatabaseUrl(url), { max: 1, prepare: false });
  try {
    // Unqualified statements in the journal need a target schema; the runtime
    // connection's search_path can be empty (e.g. Neon), so pin it. max: 1
    // keeps every statement — including drizzle's own — on this session.
    await sql.unsafe("SET search_path TO public");
    await sql.unsafe(`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
    try {
      await baselinePreJournalDatabase(sql, migrationsFolder);
      await migrate(drizzle(sql), { migrationsFolder });
      // The one data migration a journal entry can't carry: seeding membership
      // from the retired EMAIL_ALLOW_LIST, which is a per-instance environment
      // value. Runs once per database (guarded by data, not by the journal) and
      // no-ops forever after; under the same advisory lock so concurrent boots
      // can't both seed. See src/lib/access-upgrade.ts.
      await seedAccessControl(sql, {
        allowList: process.env.EMAIL_ALLOW_LIST,
        instanceCode: env.INSTANCE_CODE,
      });
      logger.info("runMigrations done");
    } finally {
      await sql.unsafe(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`);
    }
  } catch (err) {
    logger.error("runMigrations failed", { ...serializeErr(err) });
    throw err;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * If the database has the application schema but no migration journal, record
 * entry 0000 as applied — same hash and timestamp drizzle's migrator would
 * write — so migrate() picks up from 0001 instead of replaying the initial
 * CREATE TABLEs. Runs under the advisory lock.
 */
async function baselinePreJournalDatabase(
  sql: ReturnType<typeof postgres>,
  migrationsFolder: string
): Promise<void> {
  const [{ journaled, has_schema: hasSchema }] = await sql<
    { journaled: boolean; has_schema: boolean }[]
  >`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS journaled,
           to_regclass('public.datasets') IS NOT NULL AS has_schema`;
  if (journaled || !hasSchema) return;

  const journal = JSON.parse(readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8")) as {
    entries: JournalEntry[];
  };
  const first = journal.entries.find((e) => e.idx === 0);
  if (!first) throw new Error("runMigrations: journal has no entry 0000");
  const firstSql = readFileSync(path.join(migrationsFolder, `${first.tag}.sql`), "utf8");
  const hash = createHash("sha256").update(firstSql).digest("hex");

  // Mirror the DDL drizzle's migrator creates for its own table.
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS drizzle`);
  await sql.unsafe(
    `CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`
  );
  await sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${hash}, ${first.when})`;
  logger.info("runMigrations: pre-journal database baselined at 0000", { tag: first.tag });
}
