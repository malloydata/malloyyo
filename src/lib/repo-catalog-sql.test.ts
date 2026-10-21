// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// list_tables' catalog query, per dialect. Each database spells "the tables I
// can see" a little differently, and BigQuery can't answer it without a
// dataset — so these pin the spelling, the filters, and the quoting.

import { test } from "node:test";
import assert from "node:assert/strict";
import { listTablesSql } from "./repo-catalog-sql";

test("the standard information_schema query, system schemas hidden", () => {
  for (const dialect of ["duckdb", "postgres", "trino", "presto", "databricks"]) {
    const sql = listTablesSql(dialect);
    assert.equal(typeof sql, "string", dialect);
    assert.match(sql as string, /from information_schema\.tables/);
    assert.match(sql as string, /not in \('information_schema','pg_catalog'\)/);
  }
});

test("a schema narrows the list; a name pattern filters it", () => {
  const sql = listTablesSql("postgres", { schema: "sales", like: "%Order%" }) as string;
  assert.match(sql, /table_schema = 'sales'/);
  assert.match(sql, /lower\(table_name\) like '%order%'/);
  assert.doesNotMatch(sql, /pg_catalog/);
});

test("MySQL hides its own system schemas", () => {
  assert.match(listTablesSql("mysql") as string, /'performance_schema','sys'/);
});

test("Snowflake compares the schema in its upper case", () => {
  assert.match(listTablesSql("snowflake", { schema: "sales" }) as string, /table_schema = 'SALES'/);
});

test("BigQuery needs a dataset, and quotes each part of it", () => {
  const without = listTablesSql("standardsql");
  assert.equal(typeof without, "object");
  assert.match((without as { error: string }).error, /pass `schema`/);
  assert.match(
    listTablesSql("standardsql", { schema: "my-project.analytics" }) as string,
    /from `my-project`\.`analytics`\.INFORMATION_SCHEMA\.TABLES/,
  );
});

test("quotes in filters are escaped, not trusted", () => {
  const sql = listTablesSql("duckdb", { schema: "x' or '1'='1", like: "a'b" }) as string;
  assert.match(sql, /table_schema = 'x'' or ''1''=''1'/);
  assert.match(sql, /like 'a''b'/);
});

test("a backslash can't end the literal where the dialect treats it as an escape", () => {
  const like = "\\' union select 1 -- ";
  const mysql = listTablesSql("mysql", { like });
  assert.equal(typeof mysql, "string");
  assert.ok((mysql as string).includes("'\\\\'' union select 1 -- '"), mysql as string);
  // Postgres/DuckDB literals take a backslash literally: only quotes double.
  assert.ok((listTablesSql("postgres", { like }) as string).includes("'\\'' union select 1 -- '"));
});
