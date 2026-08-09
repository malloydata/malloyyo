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
// TYPES — `conn.runSQL()` returns bare `{rows, totalRows}` with no schema, and
// the DuckDB connector fills them via the node-api's `getRowObjectsJson()`,
// which stringifies BIGINT before Malloy ever assigns a type. Rows arriving
// that way are untypeable downstream: a BIGINT 1 and a VARCHAR '42' are both
// just strings, so "convert the numeric-looking ones" would corrupt real text
// columns (malloyyo#137).
//
// So we do not run raw SQL raw when we can avoid it. A row-returning statement
// goes through Malloy as `<conn>.sql("…")`, which yields a real Result with a
// schema — `jsonRows` then applies and the output matches every other Malloyyo
// surface. Only statements Malloy cannot type (COPY, DDL, several statements at
// once) take the untyped path, and those have no rows worth typing anyway. See
// runTyped below.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { MalloyConfig, Runtime, discoverConfig, type URLReader } from "@malloydata/malloy";
import { jsonRows } from "@malloyyo/mcp-engine";

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

// ── the typed path ──────────────────────────────────────────────────
//
// A row-returning statement can go through Malloy as `<conn>.sql("…")`, which
// hands back a real Result — schema and all — so `jsonRows` applies and the
// output matches every other Malloyyo surface (BIGINTs numeric, dates ISO).
// Statements Malloy cannot type (COPY, DDL, several statements at once) fail to
// COMPILE, so nothing has run, and we fall back to the raw driver path below.

/** Cap for the typed path. Malloy's own default rowLimit is 10, which would
    silently truncate; past this we hand back to the untyped path rather than
    return a short answer that looks complete. */
const TYPED_ROW_CAP = 1_000_000;

/**
 * Encode arbitrary SQL as a ONE-LINE double-quoted Malloy string literal.
 *
 * Malloy strings come in `'…'`, `"…"`, and `"""…"""`; only the first two take
 * `\X` escapes, and both are single-line. So rather than pick a fence and hope
 * the SQL does not contain it (`'` and `"` are everywhere in SQL, and a `"""`
 * fence still loses to a SQL string holding `"""`), escape into one line and
 * let quoting stop being a question at all.
 *
 * The trailing newline is load-bearing: without it a SQL that ends in a `--`
 * comment would swallow whatever follows.
 */
function malloyStringLiteral(sql: string): string {
  const body =
    sql
      .trim()
      // Malloy's sql() takes ONE statement; a trailing `;` is a parse error.
      .replace(/;\s*$/, "") + "\n";
  const escaped = body
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/**
 * Run `sql` through Malloy to get typed rows, or null if it cannot be typed —
 * in which case the caller runs it raw.
 *
 * Failure is nearly always a COMPILE failure (COPY/DDL/multi-statement), which
 * happens before execution, so falling back does not double-execute. A
 * row-returning statement with side effects that fails mid-run is the one case
 * that would run twice; vanishingly rare for a build command, and the raw path
 * would have had the same effect anyway.
 */
async function runTyped(
  cfg: MalloyConfig,
  name: string,
  sql: string,
): Promise<Record<string, unknown>[] | null> {
  // Backquoting makes any configured connection name a legal Malloy reference;
  // a name containing a backquote has no escape, so give up and run it raw.
  if (name.includes("`")) return null;
  try {
    const runtime = new Runtime({ config: cfg, urlReader: fileReader() });
    const query = `run: \`${name}\`.sql(${malloyStringLiteral(sql)})`;
    const result = await runtime.loadQuery(query).run({ rowLimit: TYPED_ROW_CAP });
    const rows = jsonRows(result);
    return rows.length >= TYPED_ROW_CAP ? null : rows;
  } catch {
    return null;
  }
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
    // Prefer the typed path — it is the only one that knows a BIGINT from a
    // VARCHAR. Both output modes use it, so `--json` and the table agree.
    let rows: readonly Record<string, unknown>[] | null = await runTyped(cfg, name, sql);
    if (rows === null) {
      const conn = await cfg.connections.lookupConnection(name);
      // runSQL executes all `;`-separated statements and returns the last result.
      const result = await conn.runSQL(sql);
      rows = result?.rows ?? [];
    }
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
