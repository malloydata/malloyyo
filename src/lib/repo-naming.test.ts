// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The pure half of naming: qualifying, splitting, and deriving a repo's slug.
// The ORDERED RESOLUTION RULE needs rows, so it is tested against a real
// Postgres in test/repo-publish.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { nameToSlug } from "@malloyyo/mcp-engine";
import { qualifiedName, repoSlugFromGitHub, splitQualified } from "./repo-names.js";

test("a repo-backed dataset's public name is <repo>:<name>", () => {
  assert.equal(qualifiedName("acme", "sales"), "acme:sales");
  // A dataset no repo publishes has no prefix: its bare name IS its identity,
  // which is why `datasets_unscoped_name_ready_unique` still exists.
  assert.equal(qualifiedName(null, "scratch"), "scratch");
  assert.equal(qualifiedName(undefined, "scratch"), "scratch");
});

test("splitting is strict, so a name that merely contains a colon is not split", () => {
  assert.deepEqual(splitQualified("acme:sales"), { repo: "acme", name: "sales" });
  assert.equal(splitQualified("sales"), null, "no qualifier");
  assert.equal(splitQualified(":sales"), null, "no repo");
  assert.equal(splitQualified("acme:"), null, "no name");
  // Two qualifiers is not a nesting; refusing is how an alias containing a colon
  // still reaches the alias table rather than being half-parsed.
  assert.equal(splitQualified("a:b:c"), null);
});

test("a repo's slug is its NAME, slugified the way a dataset directory is", () => {
  // One rule for both, so a repo and its datasets are named the same way.
  assert.equal(repoSlugFromGitHub("malloydata/malloyyo-ecommerce"), "malloyyo_ecommerce");
  assert.equal(repoSlugFromGitHub("malloyyo-ecommerce"), "malloyyo_ecommerce");
  assert.equal(repoSlugFromGitHub("malloydata/malloyyo-ecommerce.git"), "malloyyo_ecommerce");
  assert.equal(repoSlugFromGitHub("https://github.com/malloydata/Baby.Names"), "baby_names");
  assert.equal(repoSlugFromGitHub("  malloydata/sales  "), "sales");
  // Whatever `nameToSlug` does, the two agree — pinned by equality rather than
  // by restating its rules, so a change there cannot make them diverge.
  assert.equal(repoSlugFromGitHub("owner/Some Repo!!"), nameToSlug("Some Repo!!"));
});

test("the migration derives the same slug the server does", () => {
  // 0026's backfill computes a repo slug in SQL:
  //   regexp_replace(lower(leaf), '[^a-z0-9]+', '_', 'g'), trimmed of '_',
  //   left 48, where `leaf` is the last path segment with a .git suffix removed.
  // These are the cases that SQL and this TypeScript must agree on, written out
  // so a change to either is visible as a diff here. (A property test across
  // both engines would be better; this is the cheap version, and it is what
  // caught nothing so far only because the rules were written together.)
  const cases: Array<[string, string]> = [
    ["malloydata/malloyyo-babynames", "malloyyo_babynames"],
    ["malloydata/malloyyo-auto-recalls", "malloyyo_auto_recalls"],
    ["Acme/Sales_2024", "sales_2024"],
    ["owner/--weird--", "weird"],
  ];
  for (const [github, expected] of cases) {
    assert.equal(repoSlugFromGitHub(github), expected, github);
  }
});
