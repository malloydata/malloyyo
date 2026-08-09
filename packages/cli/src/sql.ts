// `malloyyo sql [connection]` — run raw SQL against a configured connection,
// using malloyyo's embedded DuckDB (and anything in malloy-config.json: md, gs,
// postgres…). A build-time helper: read a URL into parquet, export a table,
// poke at data — with only `malloyyo` on PATH, no standalone duckdb / malloy-cli.
//
// This runs SQL directly on a connection, below the restricted dashboard
// runtime (which forbids raw SQL on purpose). That gate protects the hosted
// serving path; this is a local authoring/build command, so raw SQL is the point.
//
//   echo "COPY (FROM read_csv_auto('https://…/x.csv')) TO 'docs/x.parquet'" | malloyyo sql
//   malloyyo sql -e "SELECT count(*) FROM 'docs/x.parquet'"
//   malloyyo sql md -f rollup.sql
//
// Relative file paths in the SQL resolve from the current working directory
// (DuckDB's default), so run it from the repo root — `docs/x.parquet` lands where
// the site expects it.
//
// KNOWN LIMITATION — `--json` prints BIGINT values as quoted strings
// (`{"n": "1"}`). This is NOT the malloyyo#137 bug and is not fixed by
// jsonRows(): that fix works because a Malloy Result carries a schema, and here
// there is none. `conn.runSQL()` returns bare `{rows, totalRows}` — the DuckDB
// connector reads them with the node-api's `getRowObjectsJson()`, which
// stringifies BIGINT before Malloy ever sees a type. By the time the rows reach
// this file, a BIGINT 1 and a VARCHAR '42' are both just strings with nothing to
// tell them apart, so "convert the numeric-looking ones" would corrupt real text
// columns. Deliberately left alone rather than guessed at.
//
// It matters little in practice: this is a local authoring/build command whose
// output goes to a terminal or a script, not to a chart. If you are piping
// `--json` somewhere that needs real numbers, CAST in the SQL
// (`SELECT n::INTEGER`). Raised upstream at malloydata/malloy#3031, where the
// connector does still have the column types and can convert properly.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { MalloyConfig, discoverConfig, type URLReader } from "@malloydata/malloy";

/** File-only reader for config discovery — same shape host.ts uses. */
function fileReader(): URLReader {
  return {
    readURL: async (u: URL) => {
      if (u.protocol !== "file:") {
        throw new Error(`unsupported URL scheme for import: ${u.href}`);
      }
      return fs.promises.readFile(u, "utf8");
    },
  };
}

/** malloy-config[.local].json discovery, else a bare default-DuckDB world —
    the same fallback host.ts / `malloyyo mcp` use, so `duckdb` always resolves. */
async function loadConfig(rootDir: string): Promise<MalloyConfig> {
  const rootUrl = url.pathToFileURL(rootDir.endsWith(path.sep) ? rootDir : rootDir + path.sep);
  const discovered = await discoverConfig(rootUrl, rootUrl, fileReader()).catch(() => null);
  return (
    discovered ??
    new MalloyConfig({ includeDefaultConnections: true } as never, {
      rootDirectory: rootUrl.toString(),
    })
  );
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function resolveSql(opts: { execute?: string; file?: string }): Promise<string> {
  if (opts.execute != null) return opts.execute;
  if (opts.file) return fs.promises.readFile(opts.file, "utf8");
  return readStdin();
}

export async function sqlCmd(
  connection: string | undefined,
  opts: { execute?: string; file?: string; json?: boolean; root?: string },
): Promise<void> {
  const name = connection ?? "duckdb";
  const rootDir = path.resolve(opts.root ?? ".");
  const sql = (await resolveSql(opts)).trim();
  if (!sql) {
    throw new Error("no SQL provided — pass -e <sql>, -f <file>, or pipe it via stdin");
  }

  // Registers connection types (duckdb, md, postgres, …); MUST run before a
  // MalloyConfig is built. Same ordering constraint as host.ts.
  await import("@malloydata/malloy-connections");

  const cfg = await loadConfig(rootDir);
  try {
    const conn = await cfg.connections.lookupConnection(name);
    // runSQL executes all `;`-separated statements and returns the last result.
    const result = await conn.runSQL(sql);
    const rows = result?.rows ?? [];
    if (opts.json) {
      process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    } else if (rows.length === 0) {
      console.log(`ok — statement ran on connection "${name}" (no result rows)`);
    } else {
      console.table(rows);
    }
  } finally {
    await cfg.shutdown?.();
  }
}
