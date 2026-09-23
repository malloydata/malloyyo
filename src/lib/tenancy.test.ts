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

test("a user with no address binds empty rather than undefined", () => {
  // The given is declared `:: string`, so a missing address must still be a
  // string — and an empty one matches nothing, which is the safe direction.
  assert.deepEqual(hostGivensFor({ email: null }).values, { MALLOYYO_EMAIL: "" });
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
