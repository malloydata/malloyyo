// Issue #136: a second physical copy of @malloydata/malloy splits the
// connection registry — the connectors register with one copy, malloyyo reads
// another — and every connection then fails with `No connection named "duckdb"
// found in config`, which blames malloy-config.json for a dependency-tree
// problem. These tests pin the two things that make that diagnosable: that we
// count copies by PATH (not by version — two copies of one version are still
// two registries), and that a missing-connection error carries the explanation.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  annotateConnectionError,
  duplicateMalloyReport,
  loadConnectionTypes,
  malloyCopies,
  withConnectionDiagnostics,
} from "../src/connections.js";

test("the repo's own tree resolves exactly one @malloydata/malloy", () => {
  const copies = malloyCopies();
  assert.equal(
    copies.length,
    1,
    `expected one copy, got:\n${copies.map((c) => `  ${c.version} ${c.dir}`).join("\n")}`,
  );
  // Everything that writes to the registry must resolve the copy we read.
  assert.ok(copies[0].importers.includes("malloyyo"));
  assert.ok(copies[0].importers.includes("@malloydata/malloy-connections"));
  assert.equal(duplicateMalloyReport(), null);
});

test("connection types register, and the registry we read is the one written to", async () => {
  const { types, duplicates, failures } = await loadConnectionTypes();
  assert.ok(types.includes("duckdb"), `duckdb missing from: ${types.join(", ")}`);
  assert.equal(duplicates, null);
  assert.deepEqual(failures, []);
});

test("a missing connection is annotated with what IS registered", () => {
  const out = annotateConnectionError('No connection named "md" found in config');
  assert.match(out, /No connection named "md" found in config/);
  assert.match(out, /Connection types registered: .*duckdb/);
  // A clean tree must not be accused of a duplicate install.
  assert.doesNotMatch(out, /copies of @malloydata\/malloy/);
});

test("unrelated errors pass through untouched", async () => {
  const text = "syntax error at line 3";
  assert.equal(annotateConnectionError(text), text);
  const boom = new Error(text);
  await assert.rejects(
    withConnectionDiagnostics(() => Promise.reject(boom)),
    // Identity, not just message equality: the original error object survives,
    // so callers matching on `instanceof`/custom fields still work.
    (e: unknown) => e === boom,
  );
});

test("withConnectionDiagnostics keeps the original error as `cause`", async () => {
  const boom = new Error('No connection named "duckdb" found in config');
  await assert.rejects(
    withConnectionDiagnostics(() => Promise.reject(boom)),
    (e: unknown) => e instanceof Error && e.cause === boom && /registered/.test(e.message),
  );
});

/** Lay down a stub package (package.json only — resolution is all we test). */
function stub(root: string, spec: string, version: string, deps: string[] = []): string {
  const dir = path.join(root, "node_modules", ...spec.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: spec, version, main: "index.js" }),
  );
  fs.writeFileSync(path.join(dir, "index.js"), "");
  for (const d of deps) stub(dir, d, version);
  return dir;
}

function withTree(fn: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "malloyyo-tree-"));
  try {
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("a nested copy is detected even when both copies are the SAME version", () => {
  // The heart of #136: npm nesting is what breaks this, not a version skew.
  // Two byte-identical directories are two module instances, so a version
  // comparison would call this tree healthy. Path comparison must not.
  withTree((root) => {
    stub(root, "@malloydata/malloy", "0.0.425");
    // malloy-connections carries its own nested @malloydata/malloy — the
    // connectors under it register there, we read the top-level one.
    const conns = stub(root, "@malloydata/malloy-connections", "0.0.425", [
      "@malloydata/malloy",
    ]);
    stub(conns, "@malloydata/db-duckdb", "0.0.425");

    const copies = malloyCopies(root);
    assert.equal(copies.length, 2, copies.map((c) => c.dir).join("\n"));
    assert.deepEqual(
      copies.map((c) => c.version),
      ["0.0.425", "0.0.425"],
    );
    const [ours, theirs] = copies;
    assert.deepEqual(ours.importers, ["malloyyo"]);
    assert.ok(theirs.importers.includes("@malloydata/malloy-connections"));
    // db-duckdb resolves upward to the copy nested under malloy-connections,
    // not to ours — that is exactly the split.
    assert.ok(theirs.importers.includes("@malloydata/db-duckdb"));

    const report = duplicateMalloyReport(root);
    assert.match(String(report), /2 copies of @malloydata\/malloy/);
    assert.match(String(report), /npm dedupe/);
  });
});

test("a deduped tree reports one copy shared by every registry writer", () => {
  withTree((root) => {
    stub(root, "@malloydata/malloy", "0.0.425");
    stub(root, "@malloydata/malloy-connections", "0.0.425");
    stub(root, "@malloydata/db-duckdb", "0.0.425");

    const copies = malloyCopies(root);
    assert.equal(copies.length, 1);
    assert.deepEqual(copies[0].importers, [
      "malloyyo",
      "@malloydata/malloy-connections",
      "@malloydata/db-duckdb",
    ]);
    assert.equal(duplicateMalloyReport(root), null);
  });
});
