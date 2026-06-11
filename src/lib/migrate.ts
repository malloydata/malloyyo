// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import postgres from "postgres";
import { BASELINE_SQL } from "@/db/baseline.generated";
import { logger, serializeErr } from "./logger";

// Postgres SQLSTATEs for "this object already exists" — safe to ignore so the
// baseline is a no-op on an already-initialized database.
const ALREADY_EXISTS = new Set(["42P07", "42710", "42P06", "42701", "42P16"]);

let ran = false;

/**
 * Create the full current schema on a fresh database. Idempotent: statements that
 * hit an "already exists" error are skipped, so this is a no-op once the DB is
 * initialized. Gated by RUN_MIGRATIONS_ON_BOOT (see instrumentation.ts) — the
 * one-click deploy turns it on; managed instances keep their psql migration flow.
 *
 * A fresh DB gets the current schema directly (including all columns), so the
 * incremental drizzle/manual/*.sql files (which upgrade OLDER databases) are not
 * replayed here.
 */
export async function ensureSchema(): Promise<void> {
  if (ran) return;
  ran = true;

  const url = process.env.DATABASE_URL;
  if (!url) {
    logger.warn("ensureSchema: DATABASE_URL not set, skipping");
    return;
  }

  const statements = BASELINE_SQL.split(";").map((s) => s.trim()).filter(Boolean);
  const sql = postgres(url, { max: 1, prepare: false });
  let created = 0;
  let skipped = 0;
  try {
    // Unqualified CREATE TABLEs need a target schema; the runtime connection's
    // search_path can be empty (e.g. Neon), so pin it to public explicitly.
    await sql.unsafe("SET search_path TO public");
    for (const stmt of statements) {
      try {
        await sql.unsafe(stmt);
        created++;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code && ALREADY_EXISTS.has(code)) {
          skipped++;
          continue;
        }
        throw err;
      }
    }
    logger.info("ensureSchema done", { created, skipped, total: statements.length });
  } catch (err) {
    logger.error("ensureSchema failed", { ...serializeErr(err) });
    throw err;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
