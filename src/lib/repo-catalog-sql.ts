// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// "Which tables can this connection see", spelled for each database. Pure — no
// connection, no database of ours — so it is testable on its own; list_tables
// (repo-authoring.ts) runs it.

type Fail = { ok: false; error: string };

/** Dialects whose string literals treat `\` as an escape, so it must be doubled too. */
const BACKSLASH_ESCAPES = new Set(["mysql", "standardsql", "snowflake", "databricks"]);

export function sqlString(s: string, dialect = ""): string {
  const v = BACKSLASH_ESCAPES.has(dialect) ? s.replace(/\\/g, "\\\\") : s;
  return `'${v.replace(/'/g, "''")}'`;
}

/** The catalog query for a dialect. `schema` narrows; BigQuery requires it. */
export function listTablesSql(dialect: string, opts: { schema?: string; like?: string } = {}): string | Fail {
  const filters: string[] = [];
  if (opts.like) filters.push(`lower(table_name) like ${sqlString(opts.like.toLowerCase(), dialect)}`);
  const where = (base: string[]) => {
    const all = [...base, ...filters];
    return all.length ? ` where ${all.join(" and ")}` : "";
  };
  const cols = "table_catalog as table_catalog, table_schema as table_schema, table_name as table_name, table_type as table_type";
  const schemaEq = opts.schema ? [`table_schema = ${sqlString(opts.schema, dialect)}`] : [];
  switch (dialect) {
    case "standardsql": {
      if (!opts.schema) {
        return {
          ok: false,
          error: "BigQuery lists tables one dataset at a time: pass `schema` as the dataset (`dataset` or `project.dataset`).",
        };
      }
      const qualified = opts.schema.split(".").map((p) => `\`${p.replace(/`/g, "")}\``).join(".");
      return `select ${cols} from ${qualified}.INFORMATION_SCHEMA.TABLES${where([])} order by table_name`;
    }
    case "mysql":
      return (
        `select ${cols} from information_schema.tables` +
        where(opts.schema ? schemaEq : ["table_schema not in ('information_schema','mysql','performance_schema','sys')"]) +
        " order by 1, 2, 3"
      );
    case "snowflake":
      return (
        `select ${cols} from information_schema.tables` +
        where(opts.schema ? [`table_schema = ${sqlString(opts.schema.toUpperCase(), dialect)}`] : ["table_schema <> 'INFORMATION_SCHEMA'"]) +
        " order by 1, 2, 3"
      );
    default:
      // DuckDB/MotherDuck, Postgres, Trino/Presto, Databricks: the standard view.
      return (
        `select ${cols} from information_schema.tables` +
        where(
          opts.schema
            ? schemaEq
            : ["lower(table_schema) not in ('information_schema','pg_catalog')", "lower(table_schema) not like 'pg_%'"],
        ) +
        " order by 1, 2, 3"
      );
  }
}
