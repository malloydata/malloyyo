import test from "node:test";
import assert from "node:assert/strict";
import {
  leaseScope,
  isReservedGiven,
  requirementForPublish,
  reservedGivenError,
  unsupportedReservedGivens,
} from "./tenancy";

// The rules that keep a scoped dataset from quietly becoming unscoped. The
// supply itself is core's (finalizeGivens); what is pinned here is the policy
// around it — see docs/multi-tenant-givens.md.

test("declaring the given is what scopes a dataset", () => {
  const r = requirementForPublish([], ["MALLOYYO_EMAIL", "REGION"]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.required, ["MALLOYYO_EMAIL"], "ordinary givens are not requirements");
  assert.deepEqual(r.ok && r.added, ["MALLOYYO_EMAIL"], "and it is newly recorded");
});

test("a publish that drops a recorded requirement is REFUSED", () => {
  // The accident this whole feature exists for: the model stops declaring it,
  // and without this rule the next publish serves every row to every user.
  const r = requirementForPublish(["MALLOYYO_EMAIL"], ["REGION"]);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error, /no longer declares it/);
  assert.match(r.ok ? "" : r.error, /every row to every user/);
});

test("a requirement is sticky across an ordinary publish", () => {
  const r = requirementForPublish(["MALLOYYO_EMAIL"], ["MALLOYYO_EMAIL"]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.required, ["MALLOYYO_EMAIL"]);
  assert.deepEqual(r.ok && r.added, [], "nothing new to record");
});

test("an unscoped dataset stays unscoped, and costs nothing", () => {
  const r = requirementForPublish([], ["REGION", "STATE"]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.required, []);
});

test("only the givens this server fills may use the reserved prefix", () => {
  assert.deepEqual(unsupportedReservedGivens(["MALLOYYO_EMAIL", "REGION"]), []);
  assert.deepEqual(unsupportedReservedGivens(["MALLOYYO_ROLE", "MALLOYYO_ORG"]), [
    "MALLOYYO_ORG",
    "MALLOYYO_ROLE",
  ]);
  const r = requirementForPublish([], ["MALLOYYO_ROLE"]);
  assert.equal(r.ok, false, "refused at publish, where the author is standing there");
  assert.match(reservedGivenError(["MALLOYYO_ROLE"]), /reserved/);
});

test("the prefix test is exact", () => {
  assert.equal(isReservedGiven("MALLOYYO_EMAIL"), true);
  assert.equal(isReservedGiven("malloyyo_email"), false, "givens are case-sensitive");
  assert.equal(isReservedGiven("MY_MALLOYYO_EMAIL"), false);
});

test("a lease carries the address, and finalizes every required name", () => {
  const s = leaseScope(["MALLOYYO_EMAIL"], { email: "a@b.com", roles: ["MALLOYYO_USER"] });
  assert.deepEqual(s.givens, { MALLOYYO_EMAIL: "a@b.com" });
  assert.deepEqual(s.finalize, ["MALLOYYO_EMAIL"], "core locks these against per-query override");
});

test("no address supplies NOTHING, so core refuses the query", () => {
  // Not an empty string. users.email is nullable, and `filter<string>` bound to
  // '' is an EMPTY filter — which matches every row. Supplying nothing leaves
  // the finalized given with no value, and core refuses to run. Fail closed.
  const s = leaseScope(["MALLOYYO_EMAIL"], { email: null, roles: ["MALLOYYO_USER"] });
  assert.deepEqual(s.givens, {});
  assert.deepEqual(s.finalize, ["MALLOYYO_EMAIL"], "still finalized — the lock does not depend on the value");
});

test("an unscoped dataset attaches nothing at all", () => {
  const s = leaseScope([], { email: "a@b.com", roles: ["MALLOYYO_USER"] });
  assert.deepEqual(s.givens, {});
  assert.deepEqual(s.finalize, []);
});

test("a dataset scoped by roles gets the whole list", () => {
  const s = leaseScope(["MALLOYYO_ROLES"], { email: "a@b.com", roles: ["MALLOYYO_USER", "finance"] });
  assert.deepEqual(s.givens, { MALLOYYO_ROLES: ["MALLOYYO_USER", "finance"] });
  assert.deepEqual(s.finalize, ["MALLOYYO_ROLES"], "locked, like the address");
});

test("both, when a model declares both", () => {
  const s = leaseScope(["MALLOYYO_EMAIL", "MALLOYYO_ROLES"], { email: "a@b.com", roles: ["finance"] });
  assert.deepEqual(s.givens, { MALLOYYO_EMAIL: "a@b.com", MALLOYYO_ROLES: ["finance"] });
});
