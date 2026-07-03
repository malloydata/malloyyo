// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// PIN TEST for the semi-internal (underscore) Malloy APIs the cache depends on:
// Model._modelDef (extractModelDef) and Runtime._loadModelFromModelDef
// (rehydrateModel). If a /malloy-update changes their shape, THIS fails loudly
// instead of the cache silently corrupting.
//
// Hermetic: uses an in-memory duckdb.sql() source, so no network / GCS / DB.
// Run: npm test   (tsx --test src/lib/*.test.ts)

import "@malloydata/db-duckdb/native"; // ensure the duckdb connector loads under tsx
import { test } from "node:test";
import assert from "node:assert/strict";
import * as malloy from "@malloydata/malloy";
import { DuckDBConnection } from "@malloydata/db-duckdb";
import { extractModelDef, rehydrateModel, packModelDef, unpackModelDef } from "./model-cache";

const ENTRY = new URL("file:///index.malloy");
const MODEL = `
source: nums is duckdb.sql("""
  SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
""") extend {
  measure: c is count()
  measure: total is n.sum()
}
`;

function duckdb(): DuckDBConnection {
  return new DuckDBConnection({ name: "duckdb", setupSQL: "SET home_directory='/tmp';" });
}

test("extract → pack → unpack → rehydrate → run (pins _modelDef / _loadModelFromModelDef)", async () => {
  // 1. Compile once and extract the fully-resolved ModelDef.
  const conn1 = duckdb();
  const rt1 = new malloy.SingleConnectionRuntime({
    connection: conn1,
    urlReader: new malloy.InMemoryURLReader(new Map([[ENTRY.href, MODEL]])),
  });
  const model = await rt1.getModel(ENTRY);
  const def = extractModelDef(model);
  assert.ok(def && typeof def === "object", "extractModelDef returned a ModelDef object");
  await conn1.close();

  // 2. Round-trip through the durable on-disk envelope (blob write + read back).
  const def2 = unpackModelDef(packModelDef(def));
  assert.ok(def2 !== undefined, "unpack returned the def (version envelope matched)");

  // 3. Rehydrate on a FRESH runtime with NO source files, and run — proving the
  //    model runs without any recompile / schema fetch from source.
  const conn2 = duckdb();
  const rt2 = new malloy.SingleConnectionRuntime({
    connection: conn2,
    urlReader: new malloy.InMemoryURLReader(new Map()), // deliberately empty
  });
  const mm = rehydrateModel(rt2, def2);
  const result = await mm.loadQuery("run: nums -> { aggregate: c, total }").run();
  const rows = result.data.toJSON() as Array<{ c: number; total: number }>;
  assert.equal(Number(rows[0].c), 4, "count() over the rehydrated model");
  assert.equal(Number(rows[0].total), 10, "n.sum() over the rehydrated model");
  await conn2.close();
});

test("extractModelDef throws clearly if _modelDef disappears", () => {
  assert.throws(() => extractModelDef({} as unknown), /_modelDef/);
});

test("rehydrateModel throws clearly if _loadModelFromModelDef disappears", () => {
  assert.throws(() => rehydrateModel({} as unknown as malloy.Runtime, {}), /_loadModelFromModelDef/);
});
