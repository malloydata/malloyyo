// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Pure unit tests for the ModelDef cache envelope. No DB, no Malloy runtime.
// Run: npm test   (tsx --test src/lib/*.test.ts)

import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { packModelDef, unpackModelDef, _cacheMeta } from "./model-cache";

test("pack → unpack round-trips a ModelDef-shaped object", () => {
  const def = { name: "m", exports: ["a", "b"], nested: { xs: [1, 2, 3], s: "hi", b: true, z: null } };
  const packed = packModelDef(def);
  assert.ok(Buffer.isBuffer(packed));
  assert.deepEqual(unpackModelDef(packed), def);
});

test("pack compresses (gzip envelope, not raw JSON)", () => {
  const big = { blob: "x".repeat(50_000) };
  const packed = packModelDef(big);
  assert.ok(packed.length < 5_000, `expected gzip to shrink repetitive JSON, got ${packed.length}`);
});

test("unpack returns undefined for a blob from a DIFFERENT malloy version", () => {
  const wrong = gzipSync(Buffer.from(JSON.stringify({ f: _cacheMeta.CACHE_FORMAT, m: "0.0.0-other", def: { a: 1 } })));
  assert.equal(unpackModelDef(wrong), undefined);
});

test("unpack returns undefined for a blob from a DIFFERENT cache format", () => {
  const wrong = gzipSync(
    Buffer.from(JSON.stringify({ f: _cacheMeta.CACHE_FORMAT + 99, m: _cacheMeta.MALLOY_VERSION, def: { a: 1 } })),
  );
  assert.equal(unpackModelDef(wrong), undefined);
});

test("unpack never throws on corrupt bytes — returns undefined", () => {
  assert.equal(unpackModelDef(Buffer.from("not gzip at all")), undefined);
  assert.equal(unpackModelDef(Buffer.from([])), undefined);
  assert.equal(unpackModelDef(gzipSync(Buffer.from("{not json"))), undefined);
});

test("a matching-version blob round-trips (self-consistent envelope)", () => {
  const def = { hello: "world", n: 42 };
  assert.deepEqual(unpackModelDef(packModelDef(def)), def);
});
