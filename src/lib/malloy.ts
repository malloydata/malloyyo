// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import * as malloy from "@malloydata/malloy";
import { API } from "@malloydata/malloy";
import { DuckDBConnection as MalloyDuckDBConnection } from "@malloydata/db-duckdb";
import { hostname, networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import { env } from "./env";
import type { GitHubURLReader } from "./github";
import { logger, serializeErr } from "./logger";

// DuckDB extension autoloading requires a writable home directory. Vercel/Lambda
// functions may have HOME unset or empty — default to /tmp which is always writable.
if (!process.env["HOME"]) process.env["HOME"] = "/tmp";

// Per-serverless-instance identity, for cold-start vs warm-reuse diagnostics.
// INSTANCE_ID is minted once per instance (a fresh cold instance => a new id),
// so grouping query timings by it tells us whether slow queries are always an
// instance's FIRST request (cold start) or also land on already-warm instances
// (pointing at something other than cold start — pool contention, GC, network,
// MotherDuck server-side, etc.). instanceReqN is that instance's request count.
function firstLocalIPv4(): string {
  try {
    for (const nis of Object.values(networkInterfaces())) {
      for (const ni of nis ?? []) {
        if (ni.family === "IPv4" && !ni.internal) return ni.address;
      }
    }
  } catch {
    /* ignore */
  }
  return "unknown";
}
const INSTANCE_ID = randomBytes(4).toString("hex");
const INSTANCE_HOST = hostname();
const INSTANCE_IP = firstLocalIPv4();
const INSTANCE_BOOT_MS = Date.now();
let instanceReqN = 0;

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
        logger.warn("malloy connection backend unavailable", { pkg, ...serializeErr(err) });
      }
    }
  })();
  return _connectionTypesReady;
}

function makeConnection(): MalloyDuckDBConnection {
  // With a MotherDuck token, connect to md:; otherwise plain in-memory DuckDB
  // (models define their own sources — http/parquet/attached DBs).
  const token = env.MOTHERDUCK_TOKEN;
  return new MalloyDuckDBConnection({
    name: "duckdb",
    ...(token ? { databasePath: "md:", motherDuckToken: token } : {}),
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
  // Interfaces-format result for passing to @malloydata/render on the client.
  stableResult: unknown;
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
    const stableResult = API.util.wrapResult(result);
    return { sql, rows, rowCount: rows.length, stableResult };
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
    // Only the model's public surface — exported sources. Unexported intermediates
    // (e.g. `_base`) stay private.
    const sources = compiled.exportedExplores.map((e) => ({
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

// Introspect a model from an in-memory file map (e.g. a CLI push payload).
// Mirrors introspectModelWithReader but sources bytes from the map; malloy-config.json,
// if present in the map, is split out and used to activate the right backend.
export async function introspectModelFiles(
  files: Map<string, string>,
  entryPath: string,
): Promise<{ ok: true; sources: SourceInfo[] } | { ok: false; error: string }> {
  logger.debug("introspectModelFiles start", { entryPath, fileCount: files.size });
  let handle: RuntimeHandle | undefined;
  try {
    handle = await buildRuntime(files);
    const compiled = await handle.runtime.getModel(fileUrl(entryPath));
    // Public surface only (exported sources); unexported `_base`-style sources stay private.
    const sources = compiled.exportedExplores.map((e) => ({
      name: e.name,
      description: e.annotations.forRoute('"')[0]?.content.trim() ?? null,
    }));
    logger.debug("introspectModelFiles ok", { entryPath, sourceCount: sources.length });
    return { ok: true, sources };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error("introspectModelFiles failed", { entryPath, fileCount: files.size, error });
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
// cacheManager, when shared across a pool's entries, gives every connection the
// same compiled-model cache (a warm hit skips parse/translate/schema).
async function buildRuntimeWithReader(
  reader: malloy.URLReader,
  configJson?: string,
  cacheManager?: malloy.CacheManager,
): Promise<RuntimeHandle> {
  if (configJson) {
    await ensureConnectionTypes();
    const config = new malloy.MalloyConfig(configJson, {
      overlays: malloy.defaultConfigOverlays(),
    });
    const runtime = new malloy.Runtime({ config, urlReader: reader, cacheManager });
    return { runtime, cleanup: () => runtime.shutdown("close") };
  }
  const conn = makeConnection();
  const runtime = new malloy.SingleConnectionRuntime({ connection: conn, urlReader: reader, cacheManager });
  return { runtime, cleanup: () => conn.close() };
}

// Build a throwaway Runtime from a file map. If malloy-config.json is present, uses
// MalloyConfig (BigQuery, Postgres, Snowflake, Trino, MySQL, Databricks, DuckDB).
// Falls back to a MotherDuck DuckDB SingleConnectionRuntime when no config is present.
// Used only by the cold paths (no cacheKey) — pooled callers go through poolFor().
async function buildRuntime(files: Map<string, string>): Promise<RuntimeHandle> {
  const { urlMap, configJson } = splitFiles(files);
  const reader = new malloy.InMemoryURLReader(urlMap);
  return await buildRuntimeWithReader(reader, configJson);
}

// ── Connection pooling ──────────────────────────────────────────────────────
// A warm serverless instance (Fluid Compute reuses instances) keeps a pool of
// live Runtimes per model version, so we connect to the backend (MotherDuck,
// DuckDB, Postgres, …) once and reuse it across requests instead of
// connecting+disconnecting on every query. Each pooled entry is an independent
// Runtime whose MalloyConfig memoizes one connection per name, so N entries = N
// physical connections — real concurrency up to the pool size. All entries in a
// pool share one CacheManager, so a warm hit skips parse/translate/schema as
// well as connection setup.
//
// Pools are keyed by model version id (malloy_models.id). A repo edit (model or
// malloy-config.json) lands as a new version → new key → new pool, and the old
// pool ages out of the LRU and is drained. Module-level state resets on cold
// start.
const MAX_POOLS = 16; // distinct model versions kept warm
const DEFAULT_POOL_SIZE = 5; // connections per model version

class RuntimePool {
  private idle: RuntimeHandle[] = [];
  private size = 0; // built entries (idle + currently leased)
  private waiters: Array<(e: RuntimeHandle) => void> = [];
  private draining = false;

  constructor(
    private readonly factory: () => Promise<RuntimeHandle>,
    private readonly max: number,
  ) {}

  async acquire(): Promise<RuntimeHandle> {
    const reused = this.idle.pop();
    if (reused) return reused;
    if (this.size < this.max) {
      this.size++;
      try {
        return await this.factory();
      } catch (err) {
        this.size--;
        throw err;
      }
    }
    // Pool saturated — wait for a release.
    return new Promise<RuntimeHandle>((resolve) => this.waiters.push(resolve));
  }

  release(entry: RuntimeHandle): void {
    if (this.draining) {
      this.size--;
      void entry.cleanup().catch(() => {});
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) waiter(entry);
    else this.idle.push(entry);
  }

  // Close every connection we can reach. Idle entries close now; entries that
  // are currently leased close when they're released (via the draining flag).
  async drain(): Promise<void> {
    this.draining = true;
    const idle = this.idle.splice(0);
    this.size -= idle.length;
    await Promise.all(idle.map((e) => e.cleanup().catch(() => {})));
  }
}

const pools = new Map<string, RuntimePool>();

// Per-repo pool size, optionally read from malloy-config.json. Field name is
// provisional — wired here so the size can be repo-controlled without touching
// call sites; defaults to DEFAULT_POOL_SIZE.
function poolSizeFromConfig(configJson: string | undefined): number {
  if (!configJson) return DEFAULT_POOL_SIZE;
  try {
    const n = Number((JSON.parse(configJson) as { poolSize?: unknown }).poolSize);
    if (Number.isInteger(n) && n >= 1 && n <= 20) return n;
  } catch {
    // malformed config — fall through to the default
  }
  return DEFAULT_POOL_SIZE;
}

function poolFor(cacheKey: string, files: Map<string, string>): RuntimePool {
  const existing = pools.get(cacheKey);
  if (existing) {
    // LRU bump: re-insert as most recently used.
    pools.delete(cacheKey);
    pools.set(cacheKey, existing);
    return existing;
  }
  const { urlMap, configJson } = splitFiles(files);
  // One CacheManager shared by every connection in this pool.
  const cacheManager = new malloy.CacheManager(new malloy.InMemoryModelCache());
  const factory = () =>
    buildRuntimeWithReader(new malloy.InMemoryURLReader(new Map(urlMap)), configJson, cacheManager);
  const pool = new RuntimePool(factory, poolSizeFromConfig(configJson));
  pools.set(cacheKey, pool);
  if (pools.size > MAX_POOLS) {
    const oldest = pools.keys().next().value;
    if (oldest !== undefined && oldest !== cacheKey) {
      const victim = pools.get(oldest);
      pools.delete(oldest);
      void victim?.drain().catch((err) => logger.warn("pool drain failed", serializeErr(err)));
    }
  }
  return pool;
}

// Run `fn` with a Runtime. With a cacheKey the Runtime is leased from (and
// returned to) the per-version pool, so connections are reused across requests.
// Without one (cold admin paths: dataset add/refresh, compile probe) we build a
// throwaway Runtime and close it — each runs against a one-shot or changing
// config where pooling would only leak.
async function withRuntime<T>(
  files: Map<string, string>,
  cacheKey: string | undefined,
  fn: (runtime: RuntimeHandle["runtime"]) => Promise<T>,
): Promise<T> {
  if (cacheKey) {
    const pool = poolFor(cacheKey, files);
    const entry = await pool.acquire();
    try {
      return await fn(entry.runtime);
    } finally {
      pool.release(entry);
    }
  }
  const { runtime, cleanup } = await buildRuntime(files);
  try {
    return await fn(runtime);
  } finally {
    await cleanup();
  }
}

// Lease a pooled Runtime for the mcp-engine host. The engine is pure logic over
// an injected Runtime; this hands it one (leased from the per-model-version pool
// with a cacheKey, throwaway without) plus a `readSource` for location-slicing,
// keyed exactly as the runtime's URLReader keys files (file:///<path>) — so the
// host never re-derives that map. Deliberately NO dataDir overlay — hosted
// local-data loading (MALLOY_DATA_DIR) is out of scope; models attach their own
// sources (http/parquet/attached DBs/warehouses).
export async function withModelRuntime<T>(
  files: Map<string, string>,
  cacheKey: string | undefined,
  fn: (runtime: malloy.Runtime, readSource: (href: string) => string | undefined) => Promise<T>,
): Promise<T> {
  const { urlMap } = splitFiles(files);
  const readSource = (href: string): string | undefined => urlMap.get(href);
  return withRuntime(files, cacheKey, (runtime) => fn(runtime as malloy.Runtime, readSource));
}

// Compile a file map and return the full hierarchical field tree for a named source.
export async function describeSourceFields(
  files: Map<string, string>,
  entryPath: string,
  sourceName: string,
  opts: { cacheKey?: string } = {},
): Promise<SourceDescription | null> {
  return withRuntime(files, opts.cacheKey, async (runtime) => {
    try {
      const compiled = await runtime.getModel(fileUrl(entryPath));
      const explore = compiled.explores.find((e) => e.name === sourceName);
      if (!explore) return null;
      return { primary_key: explore.primaryKey ?? null, fields: serializeFields(explore) };
    } catch {
      return null;
    }
  });
}

// Run using a file map (from DB-stored GitHub model files).
export async function runMalloyFiles(
  files: Map<string, string>,
  entryPath: string,
  query: string,
  opts: { rowLimit?: number; cacheKey?: string } = {},
): Promise<RunResult> {
  const t0 = Date.now();
  return withRuntime(files, opts.cacheKey, async (runtime) => {
    const tBuild = Date.now();
    const runner = runtime.loadModel(fileUrl(entryPath)).loadQuery(query);
    const sql = await runner.getSQL();
    const tCompile = Date.now();
    const result = await runner.run({ rowLimit: opts.rowLimit ?? DEFAULT_ROW_LIMIT });
    const tRun = Date.now();
    const rows = result.data.toJSON() as Record<string, unknown>[];
    const stableResult = API.util.wrapResult(result);
    logger.info("runMalloyFiles timing", {
      entryPath,
      acquireRuntimeMs: tBuild - t0,
      compileMs: tCompile - tBuild,
      runMs: tRun - tCompile,
      serializeMs: Date.now() - tRun,
      instanceId: INSTANCE_ID,
      instanceReqN: (instanceReqN += 1),
      instanceUptimeMs: tRun - INSTANCE_BOOT_MS,
      host: INSTANCE_HOST,
      ip: INSTANCE_IP,
    });
    return { sql, rows, rowCount: rows.length, stableResult };
  });
}

// Compile using a file map — returns SQL + source names.
export async function compileMalloyFiles(
  files: Map<string, string>,
  entryPath: string,
  query: string,
  opts: { cacheKey?: string } = {},
): Promise<CompileResult & { sources?: string[] }> {
  logger.debug("compileMalloyFiles start", { entryPath, fileCount: files.size, files: [...files.keys()], query });
  return withRuntime(files, opts.cacheKey, async (runtime) => {
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
    }
  });
}
