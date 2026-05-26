import * as malloy from "@malloydata/malloy";
import { DuckDBConnection as MalloyDuckDBConnection } from "@malloydata/db-duckdb";
import { env } from "./env";
import type { GitHubURLReader } from "./github";

function makeConnection(): MalloyDuckDBConnection {
  // Same home_directory fix as duckdb.ts — cached MotherDuck extension
  // can autoload before setupSQL runs if $HOME is unset (Vercel/Lambda).
  process.env["HOME"] = process.env["HOME"] || "/tmp";
  return new MalloyDuckDBConnection({
    name: "duckdb",
    databasePath: "md:",
    motherDuckToken: env.MOTHERDUCK_TOKEN,
    setupSQL: `SET home_directory='/tmp';`,
    enableExternalAccess: true,
  });
}

export type CompileResult =
  | { ok: true; sql: string }
  | { ok: false; error: string };

export async function compileMalloy(
  modelSource: string,
  query: string,
): Promise<CompileResult> {
  const conn = makeConnection();
  try {
    const runtime = new malloy.SingleConnectionRuntime({ connection: conn });
    const runner = runtime.loadQuery(`${modelSource}\n${query}`);
    const sql = await runner.getSQL();
    return { ok: true, sql };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await conn.close();
  }
}

export type RunResult = {
  sql: string;
  rows: Record<string, unknown>[];
  rowCount: number;
};

// Malloy's default rowLimit is 10 — far too small for analytical queries.
const DEFAULT_ROW_LIMIT = 10_000;

export async function runMalloy(
  modelSource: string,
  query: string,
  opts: { rowLimit?: number } = {},
): Promise<RunResult> {
  const conn = makeConnection();
  try {
    const runtime = new malloy.SingleConnectionRuntime({ connection: conn });
    const runner = runtime.loadQuery(`${modelSource}\n${query}`);
    const sql = await runner.getSQL();
    const result = await runner.run({ rowLimit: opts.rowLimit ?? DEFAULT_ROW_LIMIT });
    const rows = result.data.toJSON() as Record<string, unknown>[];
    return { sql, rows, rowCount: rows.length };
  } finally {
    await conn.close();
  }
}

// Build a file:// URL for a repo-relative path (e.g. "index.malloy" → file:///index.malloy).
function fileUrl(path: string): URL {
  return new URL(`file:///${path.replace(/^\//, "")}`);
}

export type SourceInfo = { name: string; description: string | null };

// Extract source names and descriptions from an inline model source string.
// Used after Claude generates a model — no URLReader needed.
export async function introspectInlineModel(modelSource: string): Promise<SourceInfo[]> {
  const conn = makeConnection();
  try {
    const urlMap = new Map([[fileUrl("index.malloy").toString(), modelSource]]);
    const reader = new malloy.InMemoryURLReader(urlMap);
    const runtime = new malloy.SingleConnectionRuntime({ connection: conn, urlReader: reader });
    const compiled = await runtime.getModel(fileUrl("index.malloy"));
    return compiled.explores.map((e) => ({
      name: e.name,
      description: e.annotations.forRoute('"')[0]?.content.trim() ?? null,
    }));
  } catch {
    return [];
  } finally {
    await conn.close();
  }
}

// Load and compile a model via a URLReader, returning source names and descriptions.
// Used during GitHub refresh — no query needed, just introspection.
export async function introspectModelWithReader(
  reader: malloy.URLReader | GitHubURLReader,
  entryPath: string,
): Promise<{ ok: true; sources: SourceInfo[] } | { ok: false; error: string }> {
  const conn = makeConnection();
  try {
    const runtime = new malloy.SingleConnectionRuntime({
      connection: conn,
      urlReader: reader as malloy.URLReader,
    });
    const compiled = await runtime.getModel(fileUrl(entryPath));
    const sources = compiled.explores.map((e) => ({
      name: e.name,
      description: e.annotations.forRoute('"')[0]?.content.trim() ?? null,
    }));
    return { ok: true, sources };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await conn.close();
  }
}

export type FieldInfo = { name: string; type: string; description: string | null };
export type SourceFields = {
  dimensions: FieldInfo[];
  measures: FieldInfo[];
  views: string[];
};

// Compile a file map and return structured field info for a named source.
export async function describeSourceFields(
  files: Map<string, string>,
  entryPath: string,
  sourceName: string,
): Promise<SourceFields | null> {
  const urlMap = new Map<string, string>();
  for (const [path, content] of files) {
    urlMap.set(fileUrl(path).toString(), content);
  }
  const reader = new malloy.InMemoryURLReader(urlMap);
  const conn = makeConnection();
  try {
    const runtime = new malloy.SingleConnectionRuntime({ connection: conn, urlReader: reader });
    const compiled = await runtime.getModel(fileUrl(entryPath));
    const explore = compiled.explores.find((e) => e.name === sourceName);
    if (!explore) return null;
    const dimensions: FieldInfo[] = [];
    const measures: FieldInfo[] = [];
    const views: string[] = [];
    for (const f of explore.intrinsicFields) {
      if (f.isQueryField()) {
        views.push(f.name);
      } else if (f.isAtomicField()) {
        const desc = f.annotations.forRoute('"')[0]?.content.trim() ?? null;
        const entry: FieldInfo = { name: f.name, type: f.type, description: desc };
        if (f.sourceWasMeasure() || f.sourceWasMeasureLike()) {
          measures.push(entry);
        } else {
          dimensions.push(entry);
        }
      }
    }
    return { dimensions, measures, views };
  } catch {
    return null;
  } finally {
    await conn.close();
  }
}

// Run using a file map (from DB-stored GitHub model files).
export async function runMalloyFiles(
  files: Map<string, string>,
  entryPath: string,
  query: string,
  opts: { rowLimit?: number } = {},
): Promise<RunResult> {
  const urlMap = new Map<string, string>();
  for (const [path, content] of files) {
    urlMap.set(fileUrl(path).toString(), content);
  }
  const reader = new malloy.InMemoryURLReader(urlMap);
  const conn = makeConnection();
  try {
    const runtime = new malloy.SingleConnectionRuntime({
      connection: conn,
      urlReader: reader,
    });
    const runner = runtime.loadModel(fileUrl(entryPath)).loadQuery(query);
    const sql = await runner.getSQL();
    const result = await runner.run({ rowLimit: opts.rowLimit ?? DEFAULT_ROW_LIMIT });
    const rows = result.data.toJSON() as Record<string, unknown>[];
    return { sql, rows, rowCount: rows.length };
  } finally {
    await conn.close();
  }
}

// Compile using a file map — returns SQL + source names.
export async function compileMalloyFiles(
  files: Map<string, string>,
  entryPath: string,
  query: string,
): Promise<CompileResult & { sources?: string[] }> {
  const urlMap = new Map<string, string>();
  for (const [path, content] of files) {
    urlMap.set(fileUrl(path).toString(), content);
  }
  const reader = new malloy.InMemoryURLReader(urlMap);
  const conn = makeConnection();
  try {
    const runtime = new malloy.SingleConnectionRuntime({
      connection: conn,
      urlReader: reader,
    });
    const url = fileUrl(entryPath);
    const runner = runtime.loadModel(url).loadQuery(query);
    const sql = await runner.getSQL();
    const compiled = await runtime.getModel(url);
    const sources = compiled.explores.map((e) => e.name);
    return { ok: true, sql, sources };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await conn.close();
  }
}
