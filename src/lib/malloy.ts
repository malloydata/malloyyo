// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import * as malloy from "@malloydata/malloy";
import { API, type GivenValue } from "@malloydata/malloy";
import { DuckDBConnection as MalloyDuckDBConnection } from "@malloydata/db-duckdb";
import { hostname, networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import { env } from "./env";
import type { GitHubURLReader } from "./github";
import { logger, serializeErr } from "./logger";
import { readModelDef, writeModelDef, packModelDef, unpackModelDef, extractModelDef, rehydrateModel } from "./model-cache";

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
    // On Vercel the working dir is READ-ONLY; only /tmp is writable. DuckDB
    // defaults its spill dir to `.tmp` in the CWD, so any query that spills
    // (large sort/aggregation, httpfs-buffered parquet) dies with
    // "Failed to create directory .tmp: Read-only file system". Point both the
    // home dir (extensions) and the temp/spill dir at /tmp.
    setupSQL: `SET home_directory='/tmp'; SET temp_directory='/tmp';`,
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
export function fileUrl(path: string): URL {
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

/** Run `fn` against a fresh Runtime backed by an on-demand `reader` (e.g. a
    GitHubURLReader that fetches each file as the compiler resolves an import).
    Used by the GitHub refresh to compile per-dashboard entries — the reader
    accumulates the dashboard files and their transitive imports as it goes. */
export async function withReaderRuntime<T>(
  reader: malloy.URLReader | GitHubURLReader,
  configJson: string | undefined,
  fn: (runtime: malloy.Runtime) => Promise<T>,
): Promise<T> {
  const handle = await buildRuntimeWithReader(reader as malloy.URLReader, configJson);
  try {
    return await fn(handle.runtime as malloy.Runtime);
  } finally {
    await handle.cleanup();
  }
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
  const entry = fileUrl("index.malloy"); // the engine loads via runtime.loadModel(ENTRY)
  return withRuntime(files, cacheKey, async (runtime) => {
    // The mcp-engine calls runtime.loadModel(ENTRY) itself, so we can't route it
    // through acquireModel. Instead: when a durable ModelDef exists, override
    // loadModel(ENTRY) on this leased runtime so the engine rehydrates (no schema
    // fetch) instead of compiling. Restored on release so the pooled runtime isn't
    // contaminated. On a cold miss, write-through after the engine has compiled.
    let rehydrated = false;
    const rt = runtime as malloy.Runtime;
    if (MODEL_DEF_CACHE && cacheKey) {
      const def = await loadDef(cacheKey);
      if (def !== undefined) {
        rehydrated = true;
        const original = rt.loadModel.bind(rt); // capture the real method before shadowing
        Object.defineProperty(rt, "loadModel", {
          configurable: true,
          writable: true,
          value: (url: URL) => (url.href === entry.href ? rehydrateModel(rt, def) : original(url)),
        });
      }
    }
    try {
      const result = await fn(rt, readSource);
      // Cold miss: the engine compiled into the pool cache; extract + persist
      // (awaited — a background write would be killed by Vercel's post-response
      // freeze). persistModelDef is bulletproof, so this can't break the query.
      if (MODEL_DEF_CACHE && cacheKey && !rehydrated) {
        await persistModelDef(cacheKey, () => rt.getModel(entry));
      }
      return result;
    } finally {
      if (rehydrated) delete (rt as unknown as Record<string, unknown>).loadModel; // restore prototype method
    }
  });
}

// Run ONE raw SQL statement on the model's own connection (the raw-query
// escape hatch — the ENGINE has already gated it read-only; this is pure
// execution). Leases from the same per-version pool as queries. The connection
// is the model's: its malloy-config.json's first named connection, or the
// default MotherDuck DuckDB fallback when it has none.
export async function runRawSQL(
  files: Map<string, string>,
  cacheKey: string | undefined,
  sql: string,
  rowLimit: number,
): Promise<{ rows: Record<string, unknown>[]; total_rows?: number }> {
  const { configJson } = splitFiles(files);
  let connectionName: string | undefined;
  if (configJson) {
    try {
      const names = Object.keys((JSON.parse(configJson) as { connections?: Record<string, unknown> }).connections ?? {});
      connectionName = names[0];
    } catch {
      // malformed config — fall through to the default lookup
    }
  }
  return withRuntime(files, cacheKey, async (runtime) => {
    const conn = await runtime.connections.lookupConnection(connectionName);
    const data = await conn.runSQL(sql, { rowLimit });
    return { rows: data.rows as Record<string, unknown>[], total_rows: data.totalRows };
  });
}

// ── Durable compiled-ModelDef cache ──────────────────────────────────────────
// When MODEL_DEF_CACHE is on, a cold instance rehydrates a fully-compiled model
// from Postgres (no schema fetch) instead of the per-source compile (worldcup:
// ~8s → ~0ms). Write-through: a cold miss compiles as before, then persists the
// ModelDef so future cold instances skip it. Keyed by model.id (= the pool
// cacheKey), immutable per version, so no invalidation. Off => exact prior behavior.
const MODEL_DEF_CACHE = process.env.MODEL_DEF_CACHE === "1" || process.env.MODEL_DEF_CACHE === "true";

type ModelMat = ReturnType<malloy.Runtime["loadModel"]>;
type CompiledModel = Awaited<ReturnType<ModelMat["getModel"]>>;

// L1: per-instance parsed-ModelDef cache keyed by model.id, LRU-bounded. Bounds
// memory (a large model's ModelDef can be several MB) and resets on cold start.
const L1_MAX = 16;
const l1 = new Map<string, unknown>();
function l1Get(key: string): unknown | undefined {
  const v = l1.get(key);
  if (v !== undefined) {
    l1.delete(key);
    l1.set(key, v); // mark most-recently-used
  }
  return v;
}
function l1Set(key: string, val: unknown): void {
  l1.delete(key);
  l1.set(key, val);
  while (l1.size > L1_MAX) {
    const oldest = l1.keys().next().value;
    if (oldest === undefined) break;
    l1.delete(oldest);
  }
}

// L1 then L2 (Postgres). Returns undefined when there's nothing durable to
// rehydrate: never persisted, or stored under a different malloy version/format
// (unpackModelDef => undefined) so it recompiles and overwrites. On a persistent
// miss it re-reads L2 each query, but write-through makes that a handful of small
// SELECTs at most, and L1 absorbs everything after.
async function loadDef(cacheKey: string): Promise<unknown | undefined> {
  const hit = l1Get(cacheKey);
  if (hit !== undefined) return hit;
  let packed: Buffer | null;
  try {
    packed = await readModelDef(cacheKey);
  } catch (err) {
    logger.warn("modelDef read failed", { cacheKey, ...serializeErr(err) });
    return undefined;
  }
  if (!packed) return undefined;
  const def = unpackModelDef(packed);
  if (def === undefined) return undefined; // corrupt, or a different malloy version
  l1Set(cacheKey, def);
  logger.info("modelDef rehydrated from db", { cacheKey, bytes: packed.length, instanceId: INSTANCE_ID });
  return def;
}

// Return a ModelMaterializer for the entry model, rehydrating from the durable
// cache when available. `persist` is true only on a cold compile whose ModelDef
// should be written back (persistModelDef) after the caller has compiled it.
async function acquireModel(
  runtime: malloy.Runtime | malloy.SingleConnectionRuntime,
  cacheKey: string | undefined,
  entryPath: string,
): Promise<{ mm: ModelMat; persist: boolean }> {
  const url = fileUrl(entryPath);
  if (MODEL_DEF_CACHE && cacheKey) {
    const def = await loadDef(cacheKey);
    if (def !== undefined) return { mm: rehydrateModel(runtime, def), persist: false };
  }
  return { mm: runtime.loadModel(url), persist: MODEL_DEF_CACHE && !!cacheKey };
}

// Extract and durably persist a freshly-compiled model's ModelDef. AWAITED by
// callers (not fire-and-forget): Vercel freezes the instance once the response is
// sent, which would kill a background write. Cold-path only, and the model is
// already compiled, so it adds ~gzip + one UPDATE to a query that just paid a full
// cold compile — negligible. BULLETPROOF: never throws (a cache-write failure or
// a malloy API change must not break an otherwise-successful query).
async function persistModelDef(cacheKey: string, getModel: () => Promise<CompiledModel>): Promise<void> {
  try {
    const def = extractModelDef(await getModel());
    l1Set(cacheKey, def);
    const packed = packModelDef(def);
    await writeModelDef(cacheKey, packed);
    logger.info("modelDef persisted", { cacheKey, bytes: packed.length });
  } catch (err) {
    logger.warn("modelDef persist failed", { cacheKey, ...serializeErr(err) });
  }
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
      const { mm, persist } = await acquireModel(runtime, opts.cacheKey, entryPath);
      const compiled = await mm.getModel();
      if (persist && opts.cacheKey) await persistModelDef(opts.cacheKey, () => Promise.resolve(compiled));
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
    const { mm, persist } = await acquireModel(runtime, opts.cacheKey, entryPath);
    const runner = mm.loadQuery(query);
    const sql = await runner.getSQL();
    const tCompile = Date.now();
    const result = await runner.run({ rowLimit: opts.rowLimit ?? DEFAULT_ROW_LIMIT });
    const tRun = Date.now();
    const rows = result.data.toJSON() as Record<string, unknown>[];
    const stableResult = API.util.wrapResult(result);
    if (persist && opts.cacheKey) await persistModelDef(opts.cacheKey, () => mm.getModel());
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

// Run a dashboard's run-expression with given values. `runExpr` is a top-level
// query name or a `<source> -> <view>` path — both compile as `run: <runExpr>`,
// so query artifacts and view artifacts share one path. Used by dashboards: the
// manifest carries the run-expression, the dashboard passes givens. Mirrors
// runMalloyFiles but binds givens (the compiler validates the values). Reuses
// the ModelDef cache via acquireModel.
export async function runNamedMalloyFiles(
  files: Map<string, string>,
  entryPath: string,
  runExpr: string,
  givens: Record<string, unknown>,
  opts: { rowLimit?: number; cacheKey?: string } = {},
): Promise<RunResult> {
  return withRuntime(files, opts.cacheKey, async (runtime) => {
    const { mm, persist } = await acquireModel(runtime, opts.cacheKey, entryPath);
    const runner = mm.loadQuery(`run: ${runExpr}`);
    // Values arrive as user JSON; the compiler validates them when binding.
    const compileOpts =
      givens && Object.keys(givens).length > 0
        ? { givens: givens as Record<string, GivenValue> }
        : undefined;
    const sql = await runner.getSQL(compileOpts);
    const result = await runner.run({ rowLimit: opts.rowLimit ?? DEFAULT_ROW_LIMIT, ...compileOpts });
    const rows = result.data.toJSON() as Record<string, unknown>[];
    const stableResult = API.util.wrapResult(result);
    if (persist && opts.cacheKey) await persistModelDef(opts.cacheKey, () => mm.getModel());
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
