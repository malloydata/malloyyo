import test from "node:test";
import assert from "node:assert/strict";
import {
  hostGivensFor,
  isReservedGiven,
  reservedGivenError,
  unsupportedReservedGivens,
} from "./tenancy";

test("the identity comes from the user, and carries the reserved prefix", () => {
  const h = hostGivensFor({ email: "a@b.com" });
  assert.deepEqual(h.values, { MALLOYYO_EMAIL: "a@b.com" });
  // The prefix is what stops a caller setting any other MALLOYYO_* given.
  assert.equal(h.reservedPrefix, "MALLOYYO_");
});

test("a user with no address supplies NOTHING, so the query is refused", () => {
  // Not an empty string. users.email is nullable, and `filter<string>` bound to
  // '' is an EMPTY filter — which matches every row. Supplying nothing makes
  // resolveHostGivens refuse the query instead. Fail closed.
  assert.deepEqual(hostGivensFor({ email: null }).values, {});
  assert.equal(hostGivensFor({ email: "" }).values.MALLOYYO_EMAIL, undefined);
  // The prefix still travels, so a caller cannot slip one in either.
  assert.equal(hostGivensFor({ email: null }).reservedPrefix, "MALLOYYO_");
});

test("only MALLOYYO_EMAIL is supported today", () => {
  assert.deepEqual(unsupportedReservedGivens(["MALLOYYO_EMAIL", "REGION"]), []);
  assert.deepEqual(unsupportedReservedGivens(["MALLOYYO_ROLE", "MALLOYYO_ORG"]), [
    "MALLOYYO_ORG",
    "MALLOYYO_ROLE",
  ]);
  assert.match(reservedGivenError(["MALLOYYO_ROLE"]), /reserved/);
});

test("the prefix test is exact", () => {
  assert.equal(isReservedGiven("MALLOYYO_EMAIL"), true);
  assert.equal(isReservedGiven("MALLOYYO_"), true);
  assert.equal(isReservedGiven("malloyyo_email"), false, "givens are case-sensitive");
  assert.equal(isReservedGiven("MY_MALLOYYO_EMAIL"), false);
});
