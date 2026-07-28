// Unit tests for the pure pieces of `dashboard bundle`.
//
// These exist because of a specific bug: the dev server and the static bundle
// each had their OWN copy of the URL<->givens encoding, and the copies drifted.
// The static one stripped the `$` prefix that the runtime keys off
// (runtime.tsx: `if (k[0] === "$")`), so every shareable link silently fell back
// to its default value. The encoding now lives in one module; these tests pin
// the contract so a future edit can't quietly change it again.

import { test } from "node:test";
import assert from "node:assert/strict";
import { givensFromSearch, givensToParams } from "../src/shared/givens-url.js";
import { findRemoteTables } from "../src/bundle.js";

test("givensFromSearch keeps the $ prefix the runtime keys off", () => {
  // The runtime ignores any key that does not start with `$`, so stripping the
  // prefix here is indistinguishable from passing nothing at all.
  assert.deepEqual(givensFromSearch("?$NAME=Emma"), { $NAME: "Emma" });
  assert.deepEqual(givensFromSearch("$NAME=Emma&$STATE=NY"), { $NAME: "Emma", $STATE: "NY" });
});

test("givensFromSearch drops the dashboard selector but nothing else", () => {
  assert.deepEqual(givensFromSearch("?d=name_explorer&$NAME=Emma"), { $NAME: "Emma" });
  // A bare (non-$) param is not a given, but it is also not `d` — keep it so a
  // future dimension-filter syntax isn't silently discarded here.
  assert.deepEqual(givensFromSearch("?d=x&other=1"), { other: "1" });
});

test("givensFromSearch handles an empty query", () => {
  assert.deepEqual(givensFromSearch(""), {});
  assert.deepEqual(givensFromSearch("?"), {});
});

test("givensFromSearch decodes values", () => {
  assert.deepEqual(givensFromSearch("?$NAME=Mary%20Jane"), { $NAME: "Mary Jane" });
});

test("givensToParams prefixes bare names and passes through prefixed ones", () => {
  assert.equal(givensToParams({ NAME: "Emma" }).toString(), "%24NAME=Emma");
  assert.equal(givensToParams({ $NAME: "Emma" }).toString(), "%24NAME=Emma");
});

test("givensToParams skips empty and nullish values", () => {
  const p = givensToParams({ NAME: "Emma", STATE: "", YEAR: null, X: undefined });
  assert.equal(p.toString(), "%24NAME=Emma");
});

test("givensToParams round-trips through givensFromSearch", () => {
  const out = givensFromSearch("?" + givensToParams({ NAME: "Emma", STATE: "NY" }).toString());
  assert.deepEqual(out, { $NAME: "Emma", $STATE: "NY" });
});

test("findRemoteTables picks up http(s) table() references", () => {
  const files = {
    "file:///gs.malloy":
      "source: t is duckdb.table('https://storage.googleapis.com/b/x.parquet')",
  };
  assert.deepEqual(findRemoteTables(files), ["https://storage.googleapis.com/b/x.parquet"]);
});

test("findRemoteTables dedupes across files and sorts", () => {
  const a = "https://example.com/a.parquet";
  const b = "https://example.com/b.parquet";
  const files = {
    "file:///one.malloy": `source: x is duckdb.table('${b}')\nsource: y is duckdb.table('${a}')`,
    "file:///two.malloy": `source: z is duckdb.table("${b}")`, // double quotes too
  };
  assert.deepEqual(findRemoteTables(files), [a, b]);
});

test("findRemoteTables ignores non-http tables", () => {
  // A MotherDuck or local table can't be preloaded into DuckDB-WASM — it isn't
  // fetchable — so it must not appear in the preload list.
  const files = {
    "file:///md.malloy": "source: t is md.table('mayolo.baby_names')",
    "file:///local.malloy": "source: u is duckdb.table('data/x.parquet')",
  };
  assert.deepEqual(findRemoteTables(files), []);
});
