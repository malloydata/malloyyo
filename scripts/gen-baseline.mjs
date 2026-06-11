// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT
//
// Regenerates src/db/baseline.generated.ts from src/db/schema.ts using
// `drizzle-kit export` (a pure schema -> SQL dump; it does NOT touch the
// drizzle journal or need a live DB). Run automatically via `prebuild`, so the
// baseline the one-click deploy applies on boot is always current.
//
// Statements stay schema-qualified ("public".) so they create explicitly in the
// public schema — the runtime connection's search_path can be empty (e.g. Neon),
// which would otherwise fail with "no schema has been selected to create in".

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const raw = execFileSync("npx", ["drizzle-kit", "export", "--sql"], {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
});

const sql = raw.trim();

const out = `// AUTO-GENERATED from src/db/schema.ts by scripts/gen-baseline.mjs — do not edit.
// The full current schema as idempotent-on-apply DDL; src/lib/migrate.ts runs it
// on boot when RUN_MIGRATIONS_ON_BOOT is set, so a fresh database self-initializes.
export const BASELINE_SQL = ${JSON.stringify(sql)};
`;

writeFileSync(join(root, "src/db/baseline.generated.ts"), out);
console.log(`gen-baseline: wrote src/db/baseline.generated.ts (${sql.length} chars)`);
