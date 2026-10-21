// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// DuckDB confined to its scratch directory. The unit tests pin the config
// transform; the integration test runs the result through MalloyConfig and the
// real native connector, so a property Malloy doesn't honour fails here rather
// than silently leaving the filesystem open.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as malloy from "@malloydata/malloy";
import {
  DuckDBSandboxError,
  discardScratchRoot,
  makeScratchRoot,
  sandboxDuckDBConnections,
} from "./duckdb-sandbox";

const transform = (connections: Record<string, unknown>, root: string) =>
  JSON.parse(sandboxDuckDBConnections(JSON.stringify({ connections }), root)).connections;

test("every duckdb connection gets the recipe, with the repo's setupSQL after it", () => {
  const root = makeScratchRoot();
  try {
    const out = transform(
      {
        duckdb: { is: "duckdb", setupSQL: "CREATE MACRO twice(x) AS x * 2", enableExternalAccess: true },
        md: { is: "duckdb", databasePath: "md:mayolo", securityPolicy: "local", allowedDirectories: ["/"] },
        pg: { is: "postgres", host: "db" },
      },
      root,
    );
    for (const name of ["duckdb", "md"]) {
      const c = out[name];
      assert.equal(c.lockConfiguration, true, name);
      assert.equal(c.enableExternalAccess, undefined, name);
      assert.equal(c.allowedDirectories, undefined, name);
      assert.equal(c.securityPolicy, undefined, name);
      assert.equal(c.tempDirectory, path.join(root, name), name);
      assert.ok(fs.existsSync(c.tempDirectory), name);
      assert.match(c.setupSQL, /SET enable_external_access=false/, name);
    }
    const sql: string = out.duckdb.setupSQL;
    assert.ok(sql.indexOf("enable_external_access=false") < sql.indexOf("CREATE MACRO twice"), "repo SQL runs after");
    assert.deepEqual(out.pg, { is: "postgres", host: "db" }, "other connection kinds untouched");
    assert.equal(out.md.databasePath, "md:mayolo");
  } finally {
    discardScratchRoot(root);
  }
});

test("a local databasePath opens read-only; in-memory and MotherDuck are untouched", () => {
  const root = makeScratchRoot();
  try {
    const out = transform(
      {
        file: { is: "duckdb", databasePath: "/srv/app.duckdb", readOnly: false },
        rel: { is: "duckdb", path: "data.duckdb" },
        mem: { is: "duckdb", databasePath: ":memory:" },
        md: { is: "duckdb", databasePath: "md:mayolo" },
      },
      root,
    );
    assert.equal(out.file.readOnly, true);
    assert.equal(out.rel.readOnly, true);
    assert.equal(out.mem.readOnly, undefined);
    assert.equal(out.md.readOnly, undefined);
  } finally {
    discardScratchRoot(root);
  }
});

test("references can't be checked, so they're refused; an explicitly sandboxed connection is left alone", () => {
  const root = makeScratchRoot();
  try {
    assert.throws(() => transform({ d: { is: "duckdb", databasePath: { env: "DB" } } }, root), DuckDBSandboxError);
    assert.throws(() => transform({ d: { is: "duckdb", setupSQL: { env: "SETUP" } } }, root), DuckDBSandboxError);
    const strict = { is: "duckdb", securityPolicy: "sandboxed", workingDirectory: "/w" };
    assert.deepEqual(transform({ d: strict }, root).d, strict);
  } finally {
    discardScratchRoot(root);
  }
});

test("through MalloyConfig and the real connector: local files refused, scratch usable, nothing widened", async () => {
  await import("@malloydata/db-duckdb/native");
  const root = makeScratchRoot();
  const config = new malloy.MalloyConfig(
    sandboxDuckDBConnections(
      JSON.stringify({ connections: { duckdb: { is: "duckdb", setupSQL: "CREATE MACRO twice(x) AS x * 2" } } }),
      root,
    ),
    { overlays: malloy.defaultConfigOverlays() },
  );
  try {
    const conn = (await config.connections.lookupConnection("duckdb")) as unknown as {
      runSQL(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
    };
    // The repo's setupSQL ran.
    assert.equal(Number((await conn.runSQL("SELECT twice(21) AS v")).rows[0].v), 42);
    // Its own scratch directory is readable.
    const mine = path.join(root, "duckdb", "ok.csv");
    fs.writeFileSync(mine, "a\n1\n");
    assert.equal(Number((await conn.runSQL(`SELECT count(*) AS n FROM read_csv('${mine}')`)).rows[0].n), 1);
    // Anything else local is not — the environment file included, and a
    // sibling scratch directory.
    for (const p of ["/etc/hosts", "/proc/self/environ", path.join(process.env.HOME ?? "/root", ".profile"), path.join(root, "..")]) {
      await assert.rejects(conn.runSQL(`SELECT * FROM read_text('${p}')`), /Permission Error|disabled/, p);
    }
    // And the boundary can't be moved from SQL.
    await assert.rejects(conn.runSQL("SET allowed_directories=['/']"), /lock|Cannot change/);
    await assert.rejects(conn.runSQL("SET enable_external_access=true"), /lock|Cannot change/);
  } finally {
    await config.shutdown("close");
    discardScratchRoot(root);
  }
});

test("a local database file: readable, not writable, and a missing one isn't created", async () => {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  await import("@malloydata/db-duckdb/native");
  const root = makeScratchRoot();
  const dbFile = path.join(root, "shipped.duckdb");
  const seed = await DuckDBInstance.create(dbFile);
  const sc = await seed.connect();
  await sc.run("CREATE TABLE t AS SELECT 7 AS v");
  sc.closeSync();
  seed.closeSync();
  const missing = path.join(root, "never-created.duckdb");
  const config = new malloy.MalloyConfig(
    sandboxDuckDBConnections(
      JSON.stringify({
        connections: { file: { is: "duckdb", databasePath: dbFile }, gone: { is: "duckdb", databasePath: missing } },
      }),
      root,
    ),
    { overlays: malloy.defaultConfigOverlays() },
  );
  type Conn = { runSQL(sql: string): Promise<{ rows: Record<string, unknown>[] }> };
  try {
    const file = (await config.connections.lookupConnection("file")) as unknown as Conn;
    assert.equal(Number((await file.runSQL("SELECT v FROM t")).rows[0].v), 7);
    await assert.rejects(file.runSQL("INSERT INTO t VALUES (8)"), /read-only|read only/i);
    const gone = (await config.connections.lookupConnection("gone")) as unknown as Conn;
    await assert.rejects(gone.runSQL("SELECT 1"));
    assert.equal(fs.existsSync(missing), false, "a read-only open creates nothing");
  } finally {
    await config.shutdown("close");
    discardScratchRoot(root);
  }
});
