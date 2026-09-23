import { test } from "node:test";
import assert from "node:assert/strict";
import { testGivensFromConfig } from "../src/test-givens";

// Local stand-ins for the givens the server fills, so a tenant-scoped model can
// be run before it is published. Read by the CLI ONLY — see the module header.

test("reads MALLOYYO_* out of the malloyyo block", () => {
  const r = testGivensFromConfig(
    JSON.stringify({ malloyyo: { test_givens: { MALLOYYO_EMAIL: "you@example.com" } } }),
  );
  assert.deepEqual(r.givens, { MALLOYYO_EMAIL: "you@example.com" });
  assert.deepEqual(r.warnings, []);
});

test("an ordinary given is not a test_given, and says why", () => {
  const r = testGivensFromConfig(JSON.stringify({ malloyyo: { test_givens: { REGION: "east" } } }));
  assert.deepEqual(r.givens, {});
  assert.match(r.warnings[0] ?? "", /only MALLOYYO_\* givens/);
});

test("an unusable value is dropped, not coerced", () => {
  const r = testGivensFromConfig(
    JSON.stringify({ malloyyo: { test_givens: { MALLOYYO_EMAIL: { nested: true } } } }),
  );
  assert.deepEqual(r.givens, {});
  assert.equal(r.warnings.length, 1);
});

test("absent, empty, and malformed configs all read as nothing", () => {
  for (const input of [undefined, null, "", "{not json", "{}", JSON.stringify({ malloyyo: {} })]) {
    const r = testGivensFromConfig(input as string | undefined);
    assert.deepEqual(r.givens, {}, String(input));
    assert.deepEqual(r.warnings, [], String(input));
  }
  // A non-object block is worth a word, since the author clearly meant something.
  const bad = testGivensFromConfig(JSON.stringify({ malloyyo: { test_givens: ["x"] } }));
  assert.equal(bad.warnings.length, 1);
});
