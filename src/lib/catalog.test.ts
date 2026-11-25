// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import * as malloy from "@malloydata/malloy";
import { CATALOG_VERSION, CatalogBackfill, catalogEntry, computeCatalog, isStale } from "./catalog";
import { fileUrl, introspectModelWithReader, newCompileCache, withReaderRuntime } from "./malloy";

const entry = { v: CATALOG_VERSION, sources: [{ source_ref: "sales" }] };

test("isStale: null, unversioned and older projections are stale; this one is not", () => {
  assert.equal(isStale(null), true);
  assert.equal(isStale({ sources: [] }), true, "no v: written before versioning");
  assert.equal(isStale({ v: CATALOG_VERSION - 1 }), true);
  assert.equal(isStale(entry), false);
  assert.equal(isStale({ v: CATALOG_VERSION + 1 }), false, "a newer server's row is kept");
});

test("catalogEntry fills in the ref and never lists the projection version", () => {
  assert.deepEqual(catalogEntry("acme:sales", entry), { model_ref: "acme:sales", sources: [{ source_ref: "sales" }] });
  assert.deepEqual(catalogEntry("acme:sales", null), { model_ref: "acme:sales" });
});

test("concurrent runs for one version share one compile", async () => {
  const backfill = new CatalogBackfill({ retryMs: 60_000 });
  let compiles = 0;
  let finish!: (v: typeof entry) => void;
  const compute = () => {
    compiles++;
    return new Promise<typeof entry>((r) => (finish = r));
  };
  const runs = [backfill.run("m1", compute), backfill.run("m1", compute), backfill.run("m1", compute)];
  finish(entry);
  assert.deepEqual(await Promise.all(runs), [entry, entry, entry]);
  assert.equal(compiles, 1);
});

test("a version that fails is not tried again until its retry is due", async () => {
  let now = 0;
  const backfill = new CatalogBackfill({ retryMs: 1000, now: () => now });
  assert.equal(await backfill.run("m1", async () => null), null);
  assert.equal(backfill.due("m1"), false, "just failed");
  now = 999;
  assert.equal(backfill.due("m1"), false);
  now = 1000;
  assert.equal(backfill.due("m1"), true, "retry window over");
  assert.equal(backfill.due("m2"), true, "other versions unaffected");
});

test("a throw is a failure, not an error; a later success clears it", async () => {
  let now = 0;
  const backfill = new CatalogBackfill({ retryMs: 1000, now: () => now });
  assert.equal(
    await backfill.run("m1", async () => {
      throw new Error("warehouse unreachable");
    }),
    null,
  );
  assert.equal(backfill.due("m1"), false);
  now = 1000;
  assert.deepEqual(await backfill.run("m1", async () => entry), entry);
  assert.equal(backfill.due("m1"), true);
});

test("publish's runtimes share one compile cache: the catalog reuses introspection's compile", async () => {
  const files = new Map([
    [
      fileUrl("index.malloy").toString(),
      `#" Sales.\nsource: sales is duckdb.sql("select 1 as n") extend { measure: c is count() }\n`,
    ],
  ]);
  const reader = new malloy.InMemoryURLReader(files);
  const cache = newCompileCache();
  // Record whether each lookup of the entry hit.
  const lookups: boolean[] = [];
  const original = cache.getCachedModelDef.bind(cache);
  cache.getCachedModelDef = async (r, url) => {
    const hit = await original(r, url);
    if (url === fileUrl("index.malloy").toString()) lookups.push(hit !== undefined);
    return hit;
  };

  const intro = await introspectModelWithReader(reader, "index.malloy", undefined, cache);
  assert.ok(intro.ok, intro.ok ? "" : intro.error);
  const catalog = await withReaderRuntime(reader, undefined, (rt) => computeCatalog(rt, fileUrl("index.malloy")), cache);

  assert.deepEqual(catalog, { v: CATALOG_VERSION, sources: [{ source_ref: "sales", description: "Sales." }] });
  assert.deepEqual(lookups, [false, true], "introspection compiled it; the catalog compile was a cache hit");
});
