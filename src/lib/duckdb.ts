import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { env } from "./env";

let _instance: DuckDBInstance | undefined;
let _setupLock: Promise<DuckDBInstance> | undefined;

function esc(s: string): string {
  return s.replace(/'/g, "''");
}

async function ensureInstance(): Promise<DuckDBInstance> {
  if (_instance) return _instance;
  _setupLock ??= (async () => {
    // DuckDB reads HOME at instance-creation time to set home_directory.
    // Vercel/Lambda don't set $HOME, so default it to /tmp before the
    // instance is created — this covers both manual LOAD and autoload
    // (cached extensions in /tmp trigger autoload on warm starts before
    // any SET home_directory SQL can run).
    process.env["HOME"] = process.env["HOME"] || "/tmp";
    process.env["motherduck_token"] = env.MOTHERDUCK_TOKEN;
    const inst = await DuckDBInstance.create(":memory:");
    const c = await inst.connect();
    try {
      await c.run(`SET home_directory='/tmp';`);
      await c.run(`INSTALL motherduck;`);
      await c.run(`LOAD motherduck;`);
    } finally {
      c.closeSync();
    }
    _instance = inst;
    return inst;
  })().catch((e) => {
    _setupLock = undefined;
    throw e;
  });
  return _setupLock;
}

export async function connect(): Promise<DuckDBConnection> {
  const inst = await ensureInstance();
  return inst.connect();
}

// Fully-qualified MotherDuck table reference for raw SQL queries.
export function mdRef(tableName: string): string {
  return `"${env.MOTHERDUCK_DATABASE}".main."${tableName}"`;
}

// Three-part reference for use in Malloy model source strings.
export function mdMalloyRef(tableName: string): string {
  return `${env.MOTHERDUCK_DATABASE}.main.${tableName}`;
}

export type ColumnInfo = {
  name: string;
  type: string;
  nullable: boolean;
};

function fileReader(url: string): string {
  const path = url.split("?")[0].toLowerCase();
  if (path.endsWith(".parquet")) return `read_parquet('${esc(url)}')`;
  if (path.endsWith(".csv") || path.endsWith(".csv.gz") || path.endsWith(".tsv"))
    return `read_csv('${esc(url)}', auto_detect=true)`;
  return `read_parquet('${esc(url)}')`;
}

export async function createTableFromUrl(
  tableName: string,
  sourceUrl: string,
): Promise<{ rowCount: number }> {
  const conn = await connect();
  try {
    await conn.run(
      `CREATE OR REPLACE TABLE ${mdRef(tableName)} AS SELECT * FROM ${fileReader(sourceUrl)};`,
    );
    const reader = await conn.runAndReadAll(
      `SELECT COUNT(*)::BIGINT AS n FROM ${mdRef(tableName)}`,
    );
    const rows = reader.getRowObjectsJson() as Array<{ n: string | number }>;
    return { rowCount: Number(rows[0]?.n ?? 0) };
  } finally {
    conn.closeSync();
  }
}

export async function describeTable(tableName: string): Promise<ColumnInfo[]> {
  const conn = await connect();
  try {
    const reader = await conn.runAndReadAll(`DESCRIBE ${mdRef(tableName)}`);
    const rows = reader.getRowObjectsJson() as Array<{
      column_name: string;
      column_type: string;
      null: string;
    }>;
    return rows.map((r) => ({
      name: r.column_name,
      type: r.column_type,
      nullable: r.null === "YES",
    }));
  } finally {
    conn.closeSync();
  }
}

export async function sampleTable(
  tableName: string,
  limit = 50,
): Promise<Record<string, unknown>[]> {
  const conn = await connect();
  try {
    const reader = await conn.runAndReadAll(
      `SELECT * FROM ${mdRef(tableName)} LIMIT ${Math.max(1, Math.min(500, limit))}`,
    );
    return reader.getRowObjectsJson() as Record<string, unknown>[];
  } finally {
    conn.closeSync();
  }
}
