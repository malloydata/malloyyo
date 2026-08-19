// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT
//
// Run the boot-time migration path (src/lib/migrate.ts) against $DATABASE_URL
// and exit nonzero on failure — the same code path instrumentation.ts runs
// when RUN_MIGRATIONS_ON_BOOT is set, callable from a shell. Used by
// scripts/migrate-test.sh (including two at once, to exercise the advisory
// lock); also handy for converging a database by hand:
//
//   DATABASE_URL=... npx tsx scripts/run-boot-migrations.ts

import { runMigrations } from "../src/lib/migrate.js";

runMigrations()
  .then(() => {
    console.log("migrations ok");
    process.exit(0);
  })
  .catch((err) => {
    console.error("migrations failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
