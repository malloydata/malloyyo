// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// A draft dashboard that filters by one of the model's givens must save.
//
// The save compiles the file twice: its body under core's restricted gate
// (against index.malloy, whose flags it inherits), then the whole file as an
// ordinary model file, which needs the givens flag in the file itself. These
// run both steps exactly as saveDraftDashboard does, for each way an author
// writes — or forgets — the flag.
//
// Hermetic: in-memory duckdb.sql() source, no network / DB.

import "@malloydata/db-duckdb/native";
import { test } from "node:test";
import assert from "node:assert/strict";
import { modelArtifact, validateRestricted } from "@malloyyo/mcp-engine";
import { fileUrl, withModelRuntime } from "@/lib/malloy";
import { draftBody, draftFile } from "./draft-text";

const MODEL = `##! experimental.givens
given:
  CATEGORY :: filter<string> is f''

source: sales is duckdb.sql("""
  SELECT * FROM (VALUES ('Shoes', 10), ('Hats', 5)) AS t(category, amount)
""") extend {
  measure: total is amount.sum()
}
`;

const DASHBOARD = `import "../index.malloy"

# artifact { name=trend title="Sales" }
query: trend is sales -> {
  where: category ~ $CATEGORY
  aggregate: total
}
`;

type EngineRuntime = Parameters<typeof validateRestricted>[0];
const base = () => new Map([["index.malloy", MODEL]]);

/** The two compile steps of saveDraftDashboard; returns the first failure. */
async function save(text: string): Promise<string | null> {
  const malloy = draftFile(text);
  const gate = await withModelRuntime(base(), undefined, (rt) =>
    validateRestricted(rt as unknown as EngineRuntime, fileUrl("index.malloy"), draftBody(malloy)),
  );
  const blocking = gate.ok
    ? []
    : gate.problems.filter((p) => p.severity === "error" && !/Model has no queries/.test(p.message));
  if (blocking.length > 0) return `gate: ${blocking.map((p) => p.message).join("; ")}`;

  const files = base();
  files.set("dashboards/trend.malloy", malloy);
  const art = await withModelRuntime(files, undefined, (rt) =>
    modelArtifact(rt as unknown as Parameters<typeof modelArtifact>[0], fileUrl("dashboards/trend.malloy"), "trend"),
  );
  if (!art.ok) return `compile: ${art.error}`;
  if (!art.artifact) return "compile: no artifact";
  return null;
}

for (const [label, flag] of [
  ["dot spelling (what models write)", "##! experimental.givens\n"],
  ["block spelling", "##! experimental { givens }\n"],
  ["no flag at all", ""],
] as const) {
  test(`a draft using $CATEGORY saves — ${label}`, async () => {
    assert.equal(await save(flag + DASHBOARD), null);
  });
}

test("any other compiler flag is still refused", async () => {
  const err = await save("##! experimental.sql_functions\n" + DASHBOARD);
  assert.match(err ?? "", /^gate: .*compiler-flag/);
});

test("the stored file carries the flag, so it promotes into a repo unchanged", () => {
  assert.match(draftFile(DASHBOARD), /^##! experimental\.givens\n/);
  // Already flagged: left exactly as written.
  const flagged = "##! experimental { givens }\n" + DASHBOARD;
  assert.equal(draftFile(flagged), flagged);
});
