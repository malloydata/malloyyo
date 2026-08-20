// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The migration journal as a contract.
//
// The drizzle/ journal is the boot-time schema path (drizzle-orm's migrate(),
// src/lib/migrate.ts). These tests pin the invariants the runtime migrator and
// the baselining flow depend on but nothing else enforces:
//
//   * journal entries are contiguous and strictly increasing in `when` — the
//     migrator gates on "last applied created_at < entry when", so a
//     non-increasing journal silently skips migrations;
//   * every journal entry's SQL file exists;
//   * no journal file that databases have already applied has been edited since —
//     the migrator gates on created_at rather than content, so such an edit is
//     silent, and fresh databases would diverge from existing ones forever.
//
// The behavior of the migrations themselves — fresh replay reproduces
// src/db/schema.ts, pre-journal databases converge, concurrent boots
// serialize, a failed migration fails /api/health — is pinned against a real
// Postgres by scripts/migrate-test.sh.
//
// Run: npm test

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { bootMigrationsEnabled, migrationGateError, recordMigrationOutcome } from "./migration-state.js";

const root = path.join(import.meta.dirname, "..", "..");
const drizzleDir = path.join(root, "drizzle");

/** (tag, sha256) for every entry real databases recorded as applied. See the test below. */
const APPLIED_IN_THE_WILD: ReadonlyArray<readonly [string, string]> = [
  ["0000_handy_malcolm_colcord", "ca039d71626a491dca7db3df26e53bf9f179c4607f3a12853f0e17d84f1fa19c"],
  ["0001_ltool_slugs", "d4ce238defee33aca37d9cd6b062a2f5830b084c8a9a92e8af9f77d657dd539e"],
  ["0002_model_publish", "eec42e5845ac5c40f6d3b17f7735f63e365df8755fbbb4336a775525a2d9aef2"],
  ["0003_history_redesign", "b474a738a6f484f2e639eeb174013f67827b281b882e0699c663b4e3d6d30611"],
  ["0004_backport_favorites", "7d8bcc52187820ad0c220b69c9f5f9a63e383da446c893af7b0f6fd9a1e9f32a"],
  ["0005_instance_settings", "e445e6b6d82508606f8909c5b88e6e8c05cef4e2b73024c1b73957d24ca4f545"],
  ["0006_signin_notice", "8562418a014bc9f9a11d483359672249242a5fc8bca1ef586de732fd8a1254d6"],
  ["0007_compiled_model_def", "0e5f00480b466c71f24446a0604484ad77516c043f49573206b6c47173475dd3"],
  ["0008_malloy_artifacts", "8712abf56b3c42a05bc43332760219f8e8dc0cfe9c1e8960c0cd465ebfa883e2"],
  ["0009_dataset_name_unique_ready", "ab3af50306713a2aa2b38696558f726ced07f49573bbcb0f09c73668d95fe2e6"],
  ["0010_external_account_id", "2ebf3b5bb61160c31302c3ec49815fe3deabbf4e937284a976a0fda6a37d86d0"],
  ["0011_integration_settings", "7df075ef570e19d6441e686deec9e541330683b99589527eb0f5414c29500692"],
  ["0012_push_catchup", "9d850c5e855ebb74d7fc2b581a7f0f84875d27b3f261de9706fb57e816d52e50"],
];

type JournalEntry = { idx: number; when: number; tag: string };
const journal = JSON.parse(readFileSync(path.join(drizzleDir, "meta", "_journal.json"), "utf8")) as {
  entries: JournalEntry[];
};

test("journal entries are contiguous, strictly increasing, and backed by files", () => {
  assert.ok(journal.entries.length >= 13, "journal lost entries");
  journal.entries.forEach((entry, i) => {
    assert.equal(entry.idx, i, `entry ${entry.tag} has idx ${entry.idx}, expected ${i}`);
    assert.ok(
      entry.tag.startsWith(String(i).padStart(4, "0") + "_"),
      `entry tag ${entry.tag} does not match its position ${i}`
    );
    if (i > 0) {
      assert.ok(
        entry.when > journal.entries[i - 1].when,
        `entry ${entry.tag} 'when' is not after ${journal.entries[i - 1].tag} — the migrator would skip it`
      );
    }
    assert.ok(existsSync(path.join(drizzleDir, `${entry.tag}.sql`)), `missing SQL file for ${entry.tag}`);
  });
});

test("no already-applied journal file has been edited", () => {
  // The hazard: drizzle's migrator gates on `created_at`, not content, so editing a
  // migration file that databases have already run is silent — fresh databases get the
  // new text, existing ones keep the old effects, and the two diverge permanently.
  //
  // These hashes are not recomputed from the files; that would be circular. They are the
  // exact values `drizzle/manual/0012_journal_baseline.sql` wrote into real databases'
  // `drizzle.__drizzle_migrations` before it was retired (2026-08-12), carried here
  // verbatim when the file was removed. Those databases are the separate authority: if a
  // file no longer hashes to the value they recorded, they and this checkout disagree.
  //
  // Scope is deliberately the same set the baseline file covered — entries known to have
  // been applied in the wild. Later entries are not pinned, so a migration can still be
  // edited while its PR is open; widening this is a separate decision.
  APPLIED_IN_THE_WILD.forEach(([tag, expected]) => {
    const file = path.join(drizzleDir, `${tag}.sql`);
    assert.ok(existsSync(file), `pinned entry ${tag} has no SQL file`);
    const actual = createHash("sha256").update(readFileSync(file, "utf8")).digest("hex");
    assert.equal(
      actual,
      expected,
      `${tag}.sql was edited after databases applied it — they will never see the change`
    );
  });
});

// Boot migrations are on by default in production, off by default in
// development, and RUN_MIGRATIONS_ON_BOOT=0/false always disables — so a
// deployment needs no flag to get a correct schema, while `npm run dev`
// pointed at a real database via local/<env> never mutates it uninvited. The
// readiness gate follows the same resolution: /api/health must answer 503
// whenever boot migrations were required and did not succeed (pinned
// end-to-end, against the default-on production server, in
// scripts/migrate-test.sh).
const savedFlag = process.env.RUN_MIGRATIONS_ON_BOOT;
const savedNodeEnv = process.env.NODE_ENV;
const savedVercel = process.env.VERCEL;
afterEach(() => {
  if (savedFlag === undefined) delete process.env.RUN_MIGRATIONS_ON_BOOT;
  else process.env.RUN_MIGRATIONS_ON_BOOT = savedFlag;
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
  if (savedVercel === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = savedVercel;
  delete globalThis.__malloyyoMigrationOutcome__;
});

test("bootMigrationsEnabled: on by default in production, off in development", () => {
  delete process.env.RUN_MIGRATIONS_ON_BOOT;
  process.env.NODE_ENV = "production";
  assert.equal(bootMigrationsEnabled(), true);
  process.env.NODE_ENV = "development";
  assert.equal(bootMigrationsEnabled(), false);
  delete process.env.NODE_ENV;
  assert.equal(bootMigrationsEnabled(), false);
});

test("bootMigrationsEnabled: explicit setting always wins", () => {
  process.env.NODE_ENV = "development";
  process.env.RUN_MIGRATIONS_ON_BOOT = "1";
  assert.equal(bootMigrationsEnabled(), true);
  process.env.NODE_ENV = "production";
  for (const off of ["0", "false", "FALSE", " 0 "]) {
    process.env.RUN_MIGRATIONS_ON_BOOT = off;
    assert.equal(bootMigrationsEnabled(), false, `expected ${JSON.stringify(off)} to disable`);
  }
});

// A function cannot finish a migration — it is frozen mid-run and the gate then
// reports "have not run" forever. On Vercel the BUILD applies the journal
// (`vercel-build`), so boot must stand down without anyone having to set a flag.
test("bootMigrationsEnabled: off on Vercel, where the build migrates instead", () => {
  delete process.env.RUN_MIGRATIONS_ON_BOOT;
  process.env.NODE_ENV = "production";
  process.env.VERCEL = "1";
  assert.equal(bootMigrationsEnabled(), false);

  // …and the readiness gate follows, so a correctly-migrated instance is ready.
  assert.equal(migrationGateError(), null);

  // An operator who really wants boot migrations on Vercel can still say so.
  process.env.RUN_MIGRATIONS_ON_BOOT = "1";
  assert.equal(bootMigrationsEnabled(), true);

  // Off Vercel, production is unchanged: still on by default.
  delete process.env.RUN_MIGRATIONS_ON_BOOT;
  delete process.env.VERCEL;
  assert.equal(bootMigrationsEnabled(), true);
});

test("migrationGateError: instances not running boot migrations are never gated", () => {
  process.env.NODE_ENV = "production";
  process.env.RUN_MIGRATIONS_ON_BOOT = "0";
  recordMigrationOutcome({ ok: false, error: "boom" });
  assert.equal(migrationGateError(), null);
});

test("migrationGateError: fails closed when migrations have not run (production default)", () => {
  process.env.NODE_ENV = "production";
  delete process.env.RUN_MIGRATIONS_ON_BOOT;
  assert.match(migrationGateError() ?? "", /not run/);
});

test("migrationGateError: reports a failed migration", () => {
  process.env.RUN_MIGRATIONS_ON_BOOT = "1";
  recordMigrationOutcome({ ok: false, error: "relation borked" });
  assert.equal(migrationGateError(), "relation borked");
});

test("migrationGateError: clear after a successful run", () => {
  process.env.RUN_MIGRATIONS_ON_BOOT = "1";
  recordMigrationOutcome({ ok: true });
  assert.equal(migrationGateError(), null);
});
