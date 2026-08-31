// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The /ltool schema panel's field list (/api/schema → describeSourceFields)
// must show only PUBLIC fields.
//
// Malloy's access modifiers live on the raw structDef field defs; the compiled
// API's `explore.allFields` hands back every field regardless, so the list used
// to offer `private:`/`internal:` names that a query can't reference. A query
// compiles against a source at access level 'public', so BOTH modifiers are
// out of reach from query text — clicking such a name in the panel and pasting
// it into the editor earns a 'field-not-accessible' error.
//
// The last test is what keeps this honest: it asserts the hidden names really
// are unqueryable, so the panel isn't hiding fields that in fact work.
//
// Hermetic: in-memory duckdb.sql() source, no network / DB.
// Run: npm test   (tsx --test src/lib/*.test.ts)

import "@malloydata/db-duckdb/native"; // ensure the duckdb connector loads under tsx
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeSourceFields, runRestrictedMalloyFiles, type FieldNode } from "./malloy";

const MODEL = `
##! experimental.access_modifiers

source: base is duckdb.sql("""
  SELECT 1 AS n, 'a' AS label UNION ALL SELECT 2, 'b'
""") extend {
  dimension: secret_note is 'hush'
  measure: secret_total is n.sum()
}

source: parts is duckdb.sql("SELECT 1 AS n, 'p' AS part") extend {
  private dimension: part_secret is 'hidden join field'
  dimension: part_label is part
}

source: nums is base extend {
  join_one: parts on n = parts.n

  private dimension: hidden_dim is 'nope'
  internal dimension: staff_dim is 'staff only'
  private measure: hidden_measure is count()
  internal measure: staff_measure is count()

  dimension: shown_dim is label
  measure: shown_measure is count()

  private view: hidden_view is { group_by: label }
  view: shown_view is { group_by: label }
}

// A join can carry a modifier too.
source: joins is base extend {
  private join_one: hidden_join is parts on n = hidden_join.n
  join_one: shown_join is parts on n = shown_join.n
}

source: pk_src is duckdb.sql("SELECT 1 as id, 'x' as tag") extend { primary_key: id }

// A source can demote its own primary key.
source: pk_hidden is pk_src include { public: tag; private: id }

// An include block can demote a field the base source declared public.
source: included is base include {
  public: n, label
  private: secret_note
  internal: secret_total
}
`;

const files = () => new Map([["index.malloy", MODEL]]);

async function fieldNames(source: string): Promise<string[]> {
  const desc = await describeSourceFields(files(), "index.malloy", source, {});
  assert.ok(desc, `describeSourceFields returned null for '${source}'`);
  return desc.fields.map((f) => f.name);
}

async function fieldTree(source: string): Promise<FieldNode[]> {
  const desc = await describeSourceFields(files(), "index.malloy", source, {});
  assert.ok(desc, `describeSourceFields returned null for '${source}'`);
  return desc.fields;
}

test("private and internal fields are omitted from the field list", async () => {
  const names = await fieldNames("nums");
  for (const hidden of [
    "hidden_dim",
    "staff_dim",
    "hidden_measure",
    "staff_measure",
    "hidden_view",
  ]) {
    assert.equal(names.includes(hidden), false, `'${hidden}' must not be listed`);
  }
});

test("public fields are still listed", async () => {
  const names = await fieldNames("nums");
  for (const shown of ["n", "label", "shown_dim", "shown_measure", "shown_view", "parts"]) {
    assert.ok(names.includes(shown), `'${shown}' should be listed, got: ${names.join(", ")}`);
  }
});

test("a private join is omitted; a public one is kept", async () => {
  const names = await fieldNames("joins");
  assert.equal(names.includes("hidden_join"), false, "'hidden_join' must not be listed");
  assert.ok(names.includes("shown_join"), "'shown_join' should be listed");
});

test("fields inside a join are filtered too", async () => {
  const join = (await fieldTree("nums")).find((f) => f.name === "parts");
  assert.ok(join, "the 'parts' join should be listed");
  const sub = (join.fields ?? []).map((f) => f.name);
  assert.equal(sub.includes("part_secret"), false, "'part_secret' must not be listed");
  assert.ok(sub.includes("part_label"), `'part_label' should be listed, got: ${sub.join(", ")}`);
});

test("an include block's demotions are respected", async () => {
  const names = await fieldNames("included");
  assert.equal(names.includes("secret_note"), false, "'secret_note' must not be listed");
  assert.equal(names.includes("secret_total"), false, "'secret_total' must not be listed");
  assert.ok(names.includes("n"), "'n' should be listed");
});

test("a primary key that was demoted is not advertised", async () => {
  // Naming a key the panel just dropped hands the reader an identifier they
  // cannot write.
  const hidden = await describeSourceFields(files(), "index.malloy", "pk_hidden", {});
  assert.ok(hidden);
  assert.deepEqual(hidden.fields.map((f) => f.name), ["tag"]);
  assert.equal(hidden.primary_key, null);
  const kept = await describeSourceFields(files(), "index.malloy", "pk_src", {});
  assert.equal(kept?.primary_key, "id", "a public primary key still shows");
});

// The point of the filter: everything it hides really is unreachable from a
// query, and everything it keeps really does run.
test("hidden fields are unqueryable, listed ones run", async () => {
  for (const hidden of ["hidden_dim", "staff_dim"]) {
    await assert.rejects(
      () => runRestrictedMalloyFiles(files(), "index.malloy", `run: nums -> { group_by: ${hidden} }`, { rowLimit: 10 }),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.match(msg, /not accessible|is private|is internal/i, `unexpected error for ${hidden}: ${msg}`);
        return true;
      },
      `'${hidden}' should not be queryable`,
    );
  }
  const ok = await runRestrictedMalloyFiles(
    files(),
    "index.malloy",
    "run: nums -> { group_by: shown_dim; aggregate: shown_measure }",
    { rowLimit: 10 },
  );
  assert.ok(ok.rowCount > 0, "the public fields should still query");
});
