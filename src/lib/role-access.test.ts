// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// What a set of roles adds up to (src/lib/role-access.ts) — the arithmetic
// Admin → Users & roles shows. That it MATCHES what the server enforces is pinned
// against a database in test/dashboard-audience.test.ts; this pins the
// arithmetic itself, case by case.

import test from "node:test";
import assert from "node:assert/strict";
import { bestLevel, resolveAccess, roleLevelOn, type DatasetGrants } from "./role-access";

const sales: DatasetGrants = { id: "sales", roles: ["analysts", "executives"], viewOnlyRoles: ["executives"] };
const support: DatasetGrants = { id: "support", roles: ["analysts"], viewOnlyRoles: ["analysts"] };
const web: DatasetGrants = { id: "web", roles: [], viewOnlyRoles: [] };
const all = [sales, support, web];
const levelsOf = (held: string[], who = {}) =>
  Object.fromEntries(resolveAccess(held, all, who).map((a) => [a.datasetId, a.level]));

test("a role's level is read off the dataset's two arrays", () => {
  assert.equal(roleLevelOn(sales, "analysts"), "query", "listed, and not view-only: full");
  assert.equal(roleLevelOn(sales, "executives"), "view", "listed in both: dashboards");
  assert.equal(roleLevelOn(sales, "clients"), "none", "not listed");
  // In `view_only_roles` without being in `roles` is not access. The write path
  // never leaves a row that way, and reading it as "view" would be inventing a
  // grant out of a half-finished edit.
  assert.equal(roleLevelOn({ roles: [], viewOnlyRoles: ["ghost"] }, "ghost"), "none");
  // Rows from before the second array existed read as they always did.
  assert.equal(roleLevelOn({ roles: ["old"], viewOnlyRoles: null }, "old"), "query");
});

test("the higher level wins", () => {
  assert.equal(bestLevel([]), "none");
  assert.equal(bestLevel(["none", "view"]), "view");
  assert.equal(bestLevel(["view", "query", "none"]), "query");
});

test("several roles add up dataset by dataset, and say which role is why", () => {
  assert.deepEqual(levelsOf(["executives"]), { sales: "view", support: "none", web: "none" });
  assert.deepEqual(levelsOf(["analysts"]), { sales: "query", support: "view", web: "none" });
  // Both: full on sales comes from analysts alone, though executives opens it too.
  const both = resolveAccess(["analysts", "executives"], all);
  assert.deepEqual(both[0], { datasetId: "sales", level: "query", because: ["analysts"] });
  assert.deepEqual(both[1], { datasetId: "support", level: "view", because: ["analysts"] });
  assert.deepEqual(both[2], { datasetId: "web", level: "none", because: [] });
  // Two roles giving the SAME winning level are both named.
  const twice = resolveAccess(["a", "b"], [{ id: "d", roles: ["a", "b"], viewOnlyRoles: [] }]);
  assert.deepEqual(twice[0]!.because, ["a", "b"]);
});

test("an admin has full on everything, whatever else they hold", () => {
  assert.deepEqual(levelsOf(["MALLOYYO_ADMIN"]), { sales: "query", support: "query", web: "query" });
  assert.deepEqual(resolveAccess(["executives", "MALLOYYO_ADMIN"], [sales])[0]!.because, ["MALLOYYO_ADMIN"]);
});

test("owning a dataset, and the public flag, are full access that is not a role", () => {
  const mine: DatasetGrants = { id: "mine", roles: [], viewOnlyRoles: [], ownerId: "u1" };
  const open: DatasetGrants = { id: "open", roles: ["readers"], viewOnlyRoles: ["readers"], isPublic: true };
  assert.deepEqual(resolveAccess([], [mine], { userId: "u1" })[0], { datasetId: "mine", level: "query", because: ["owner"] });
  assert.equal(resolveAccess([], [mine], { userId: "u2" })[0]!.level, "none");
  // Public beats a dashboards-only role on the same dataset: the higher wins.
  assert.deepEqual(resolveAccess(["readers"], [open])[0], {
    datasetId: "open",
    level: "query",
    because: ["public dataset"],
  });
});
