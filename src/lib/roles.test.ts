// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import "./unit-test-env";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { datasets, db } from "@/db";
import {
  BUILTIN_ROLES,
  MALLOYYO_ADMIN,
  MALLOYYO_USER,
  NEVER_A_DEFAULT,
  canAuthor,
  datasetRoleOverlap,
  datasetVisibleWhere,
  isBuiltinRole,
  isEnvAdmin,
  roleNameError,
  rolesOf,
} from "./roles";

// env.APP_ADMIN_EMAILS is a getter, so setting the variable around the run is
// enough — one of the things pinned below is that an admin granted this way is
// visible to rolesOf() and NOT revocable by any write to the row.
const savedAdmins = process.env.APP_ADMIN_EMAILS;
before(() => {
  process.env.APP_ADMIN_EMAILS = "env-admin@example.com";
});
after(() => {
  if (savedAdmins === undefined) delete process.env.APP_ADMIN_EMAILS;
  else process.env.APP_ADMIN_EMAILS = savedAdmins;
});

// Roles answer ONE question — which datasets may I open — and the built-ins also
// say what someone may do here. What is pinned below is mostly the seam between
// the roles array and the older `role`/`is_admin` columns, because those still
// exist on every upgraded instance and every bug in this file so far has been a
// disagreement between two readings of the same person.

test("rolesOf: the array is the list", () => {
  assert.deepEqual(rolesOf({ roles: ["finance", "sales"] }), ["finance", "sales"]);
});

test("rolesOf: the legacy admin columns still count", () => {
  // 0021 backfills `roles` and LEAVES `role`/`is_admin` in place, so these are
  // the live shape of every pre-roles admin, not a historical curiosity.
  assert.ok(rolesOf({ role: "admin" }).includes(MALLOYYO_ADMIN));
  assert.ok(rolesOf({ role: "owner" }).includes(MALLOYYO_ADMIN));
  assert.ok(rolesOf({ isAdmin: true }).includes(MALLOYYO_ADMIN));
  assert.ok(!rolesOf({ role: "member" }).includes(MALLOYYO_ADMIN));
});

test("rolesOf: APP_ADMIN_EMAILS is an admin the database cannot demote", () => {
  // The reason isAdmin() is defined in terms of rolesOf(): this admin has no row
  // state saying so, and a UI reading the column alone would show them as an
  // ordinary member while every admin route let them in.
  assert.ok(rolesOf({ email: "env-admin@example.com" }).includes(MALLOYYO_ADMIN));
  assert.ok(rolesOf({ email: "ENV-ADMIN@EXAMPLE.COM" }).includes(MALLOYYO_ADMIN), "case-folded");
  assert.ok(isEnvAdmin("env-admin@example.com"));
  assert.ok(!isEnvAdmin("someone@example.com"));
  assert.ok(!isEnvAdmin(null));
});

test("rolesOf: holding nothing means holding NOTHING", () => {
  // No MALLOYYO_USER fallback, and that is the point. `datasetRoleOverlap`
  // compares against the raw column, so a synthesised role here would mean the
  // list app code filters on is not the list access was decided on — an admin
  // page asserting a grant that every query denies.
  assert.deepEqual(rolesOf({ roles: [] }), []);
  assert.deepEqual(rolesOf({ roles: null }), []);
  assert.deepEqual(rolesOf({}), []);
});

test("canAuthor: admins, and nobody else", () => {
  // There was a MALLOYYO_DEVELOPER here. It is gone: creating a dataset names a
  // repo this server compiles, and a model can reach the server's environment,
  // so the role could not mean what its description said. See canAuthor.
  assert.ok(canAuthor({ roles: [MALLOYYO_ADMIN] }));
  assert.ok(canAuthor({ role: "admin" }), "a legacy admin can still author");
  assert.ok(!canAuthor({ roles: [MALLOYYO_USER] }));
  assert.ok(!canAuthor({ roles: ["finance"] }));
  assert.ok(!canAuthor({ roles: ["MALLOYYO_DEVELOPER"] }), "the removed role grants nothing");
  assert.ok(!canAuthor({}));
});

test("the privileged built-ins are never an admission default", () => {
  // On an `open` instance default_roles is applied to everyone who signs in, so
  // this one here grants admin to the internet. MALLOYYO_USER is fine: it is the
  // right to sign in and nothing else.
  assert.deepEqual([...NEVER_A_DEFAULT], [MALLOYYO_ADMIN]);
  assert.ok(!NEVER_A_DEFAULT.includes(MALLOYYO_USER));
});

test("roleNameError: the MALLOYYO_ prefix is reserved", () => {
  // A role that looks built-in would read as authority nobody granted.
  assert.ok(roleNameError("MALLOYYO_ANYTHING"));
  for (const r of BUILTIN_ROLES) assert.ok(roleNameError(r), `${r} cannot be re-created`);
  assert.ok(isBuiltinRole(MALLOYYO_USER));
  assert.ok(!isBuiltinRole("finance"));
});

test("roleNameError: lowercase, because models compare against these", () => {
  assert.equal(roleNameError("finance"), null);
  assert.equal(roleNameError("acme-corp"), null);
  assert.equal(roleNameError("tier_2"), null);
  assert.ok(roleNameError("Finance"), "case would not match a lowercase column");
  assert.ok(roleNameError("f"), "too short");
  assert.ok(roleNameError("2fast"), "must start with a letter");
  assert.ok(roleNameError("finance team"), "no spaces");
  assert.ok(roleNameError(""), "empty");
  assert.ok(roleNameError("a".repeat(41)), "too long");
  // A trailing separator would read as a truncated name.
  assert.ok(roleNameError("finance-"));
});

// ── The access predicate ────────────────────────────────────────────────────
//
// `datasetVisibleWhere` decides which datasets a person may open, and every read
// path in the app funnels through it. Pinned as generated SQL because there is no
// database here: the point is that all four clauses are present and joined the
// way they are meant to be. Replacing the body with `true` passes no test that
// does not look at this.

test("datasetVisibleWhere: owner OR public OR role overlap, AND ready", () => {
  const { sql: text, params } = db
    .select()
    .from(datasets)
    .where(datasetVisibleWhere("11111111-1111-1111-1111-111111111111"))
    .toSQL();

  // Ready is an AND over the whole disjunction, not a fourth alternative — a
  // half-built dataset must not be openable by its owner either.
  const any = "[\\s\\S]*";
  assert.match(
    text,
    new RegExp(`\\(${any}user_id${any}\\sor\\s${any}is_public${any}\\sor\\s${any}&&${any}\\)\\sand\\s${any}status`, "i"),
  );
  // The overlap reads the asker's own row rather than a list passed in, so no
  // caller can widen it by supplying one.
  assert.match(text, /&&\s*\(select coalesce\(/i);
  assert.match(text, /from "users" where/i);
  // Bound, never interpolated.
  assert.ok(params.includes("11111111-1111-1111-1111-111111111111"), "the id is a parameter");
  assert.ok(!text.includes("11111111"), "…and appears nowhere in the SQL text");
  // Being an admin is deliberately NOT a way in: running a query returns rows,
  // and administering an instance has never been a reason to read its data.
  assert.ok(!/is_admin/i.test(text), "admin is not a visibility clause");
});

test("datasetRoleOverlap: a NULL roles column cannot match", () => {
  // Every degenerate case has to fail closed. `coalesce` is what makes a row with
  // no roles compare as the empty array, and `array && '{}'` is false rather than
  // NULL-and-surprising.
  const { sql: text } = db
    .select()
    .from(datasets)
    .where(datasetRoleOverlap("22222222-2222-2222-2222-222222222222"))
    .toSQL();
  assert.match(text, /coalesce\(\s*"users"\."roles",\s*'\{\}'::text\[\]\s*\)/i);
});
