import { test } from "node:test";
import assert from "node:assert/strict";
import { asRunText } from "../src/frame-runtime/run-text";

// A dashboard's query text should be the same text the MCP `query` tool takes:
// a bare run-expression, a `run:` statement, or a document that defines
// sources and then runs one.

test("a bare run-expression gets the run: it needs", () => {
  assert.equal(asRunText("flights -> by_carrier"), "run: flights -> by_carrier");
  assert.equal(asRunText("  by_carrier  "), "run:   by_carrier  ");
});

test("a run statement is left alone", () => {
  assert.equal(asRunText("run: flights -> by_carrier"), "run: flights -> by_carrier");
  assert.equal(asRunText("\n  run: flights -> by_carrier\n"), "\n  run: flights -> by_carrier\n");
});

test("a document passes through — prefixing it made `run: source:`, a syntax error", () => {
  const doc = `source: recent is flights extend { measure: n is count() }\nrun: recent -> { aggregate: n }`;
  assert.equal(asRunText(doc), doc);
  const withFlag = `##! experimental { givens }\nrun: flights -> by_carrier`;
  assert.equal(asRunText(withFlag), withFlag);
});

test("a document with nothing to run is still passed through, so the compiler can say so", () => {
  // The server turns "Model has no queries" into an actionable message; wrapping
  // this in `run:` would hide it behind a syntax error instead.
  const defs = `source: recent is flights extend { measure: n is count() }`;
  assert.equal(asRunText(defs), defs);
});
