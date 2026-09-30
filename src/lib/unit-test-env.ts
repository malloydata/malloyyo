// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Import FIRST from a unit test whose subject imports `@/db`.
//
// `src/db/index.ts` reads `env.DATABASE_URL` at module load to build the pool
// config — it does not connect (postgres() is lazy about that), but the getter
// throws when the variable is absent, so importing any module that re-exports
// `db` fails before a single test runs. A placeholder is enough: nothing here
// opens a socket, and a test that actually needs a database is an integration
// test and lives in test/ with a real one.
//
// Not named *.test.ts deliberately — the runner's glob would collect it.
process.env.DATABASE_URL ??= "postgres://unit:test@127.0.0.1:1/unit_test_placeholder";
