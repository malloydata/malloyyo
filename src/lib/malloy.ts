import * as malloy from "@malloydata/malloy";
import { DuckDBConnection as MalloyDuckDBConnection } from "@malloydata/db-duckdb";
import { env } from "./env";
import type { GitHubURLReader } from "./github";
import { logger } from "./logger";

// DB backends are registered lazily (on first malloy-config.json use) so a broken
// native dependency (e.g. lz4 for Databricks) cannot crash the module at load time.
let _connectionTypesReady: Promise<void> | null = null;

function ensureConnectionTypes(): Promise<void> {
  if (_connectionTypesReady) return _connectionTypesReady;
  _connectionTypesReady = (async () => {
    const pkgs = [
      "@malloydata/db-duckdb/native",
      "@malloydata/db-postgres",
      "@malloydata/db-bigquery",
      "@malloydata/db-snowflake",
      "@malloydata/db-trino",
      "@malloydata/db-mysql",
    ];
    for (const pkg of pkgs) {
      try {
        await import(pkg);
      } catch (err) {
        logger.warn("malloy connection backend unavailable", { pkg, err: err instanceof Error ? err.message : String(err) });
      }
    }
  })();
  return _connectionTypesReady;
}

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
  logger.debug("compileMalloy start", { sourceLen: modelSource.length, query });
  const conn = makeConnection();
  try {
    const runtime = new malloy.SingleConnectionRuntime({ connection: conn });
    const runner = runtime.loadQuery(`${modelSource}\n${query}`);
    const sql = await runner.getSQL();
    logger.debug("compileMalloy ok");
    return { ok: true, sql };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error("compileMalloy failed", { error, sourcePreview: modelSource.slice(0, 200) });
    return { ok: false, error };
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

// Load and compile a model via a URLReader, returning source names and descriptions.
// configJson, when provided, activates the appropriate backend (Postgres, BigQuery, etc.)
// instead of the default MotherDuck DuckDB fallback.
export async function introspectModelWithReader(
  reader: malloy.URLReader | GitHubURLReader,
  entryPath: string,
  configJson?: string,
): Promise<{ ok: true; sources: SourceInfo[] } | { ok: false; error: string }> {
  logger.debug("introspectModel start", { entryPath, hasConfig: !!configJson });
  let handle: RuntimeHandle | undefined;
  try {
    handle = await buildRuntimeWithReader(reader as malloy.URLReader, configJson);
    const compiled = await handle.runtime.getModel(fileUrl(entryPath));
    const sources = compiled.explores.map((e) => ({
      name: e.name,
      description: e.annotations.forRoute('"')[0]?.content.trim() ?? null,
    }));
    logger.debug("introspectModel ok", { entryPath, sourceCount: sources.length, sources: sources.map((s) => s.name) });
    return { ok: true, sources };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error("introspectModel failed", { entryPath, hasConfig: !!configJson, error });
    return { ok: false, error };
  } finally {
    await handle?.cleanup();
  }
}

export type FieldNode = {
  name: string;
  kind: "dimension" | "measure" | "view" | "join";
  type?: string;
  description: string | null;
  relationship?: string;
  fields?: FieldNode[];
};

function serializeFields(explore: malloy.Explore): FieldNode[] {
  return explore.allFields.map((f) => {
    const description = f.annotations.forRoute('"')[0]?.content.trim() ?? null;
    if (f.isQueryField()) return { name: f.name, kind: "view" as const, description };
    if (f.isExploreField()) return {
      name: f.name, kind: "join" as const, description,
      relationship: f.joinRelationship,
      fields: serializeFields(f),
    };
    // isCalculation() = aggregate expression → measure; everything else is a dimension
    const kind = (f.isAtomicField() && f.isCalculation()) ? "measure" as const : "dimension" as const;
    return { name: f.name, kind, type: f.isAtomicField() ? f.type : undefined, description };
  });
}

export type SourceDescription = {
  primary_key: string | null;
  fields: FieldNode[];
};

// Split a file map into a URL reader map and an optional malloy-config.json string.
// malloy-config.json is config, not a Malloy source file, so it's excluded from the URL map.
function splitFiles(files: Map<string, string>): {
  urlMap: Map<string, string>;
  configJson: string | undefined;
} {
  const urlMap = new Map<string, string>();
  let configJson: string | undefined;
  for (const [path, content] of files) {
    if (path === "malloy-config.json") {
      configJson = content;
    } else {
      urlMap.set(fileUrl(path).toString(), content);
    }
  }
  return { urlMap, configJson };
}

type RuntimeHandle = {
  runtime: malloy.Runtime | malloy.SingleConnectionRuntime;
  cleanup: () => Promise<void>;
};

// Build a Runtime backed by a pre-supplied URLReader (e.g. GitHubURLReader).
// configJson, if provided, activates the MalloyConfig path; otherwise falls back to DuckDB.
async function buildRuntimeWithReader(
  reader: malloy.URLReader,
  configJson?: string,
): Promise<RuntimeHandle> {
  if (configJson) {
    await ensureConnectionTypes();
    const config = new malloy.MalloyConfig(configJson, {
      overlays: malloy.defaultConfigOverlays(),
    });
    const runtime = new malloy.Runtime({ config, urlReader: reader });
    return { runtime, cleanup: () => runtime.shutdown("close") };
  }
  const conn = makeConnection();
  const runtime = new malloy.SingleConnectionRuntime({ connection: conn, urlReader: reader });
  return { runtime, cleanup: () => conn.close() };
}

// Build a Runtime from a file map. If malloy-config.json is present, uses MalloyConfig
// (which supports BigQuery, Postgres, Snowflake, Trino, MySQL, Databricks, DuckDB).
// Falls back to a MotherDuck DuckDB SingleConnectionRuntime when no config is present.
async function buildRuntime(files: Map<string, string>): Promise<RuntimeHandle> {
  const { urlMap, configJson } = splitFiles(files);
  const reader = new malloy.InMemoryURLReader(urlMap);
  return await buildRuntimeWithReader(reader, configJson);
}

// Compile a file map and return the full hierarchical field tree for a named source.
export async function describeSourceFields(
  files: Map<string, string>,
  entryPath: string,
  sourceName: string,
): Promise<SourceDescription | null> {
  const { runtime, cleanup } = await buildRuntime(files);
  try {
    const compiled = await runtime.getModel(fileUrl(entryPath));
    const explore = compiled.explores.find((e) => e.name === sourceName);
    if (!explore) return null;
    return { primary_key: explore.primaryKey ?? null, fields: serializeFields(explore) };
  } catch {
    return null;
  } finally {
    await cleanup();
  }
}

// Run using a file map (from DB-stored GitHub model files).
export async function runMalloyFiles(
  files: Map<string, string>,
  entryPath: string,
  query: string,
  opts: { rowLimit?: number } = {},
): Promise<RunResult> {
  const { runtime, cleanup } = await buildRuntime(files);
  try {
    const runner = runtime.loadModel(fileUrl(entryPath)).loadQuery(query);
    const sql = await runner.getSQL();
    const result = await runner.run({ rowLimit: opts.rowLimit ?? DEFAULT_ROW_LIMIT });
    const rows = result.data.toJSON() as Record<string, unknown>[];
    return { sql, rows, rowCount: rows.length };
  } finally {
    await cleanup();
  }
}

// Compile using a file map — returns SQL + source names.
export async function compileMalloyFiles(
  files: Map<string, string>,
  entryPath: string,
  query: string,
): Promise<CompileResult & { sources?: string[] }> {
  logger.debug("compileMalloyFiles start", { entryPath, fileCount: files.size, files: [...files.keys()], query });
  const { runtime, cleanup } = await buildRuntime(files);
  try {
    const url = fileUrl(entryPath);
    const runner = runtime.loadModel(url).loadQuery(query);
    const sql = await runner.getSQL();
    const compiled = await runtime.getModel(url);
    const sources = compiled.explores.map((e) => e.name);
    logger.debug("compileMalloyFiles ok", { entryPath, sources });
    return { ok: true, sql, sources };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error("compileMalloyFiles failed", { entryPath, fileCount: files.size, files: [...files.keys()], error });
    return { ok: false, error };
  } finally {
    await cleanup();
  }
}
