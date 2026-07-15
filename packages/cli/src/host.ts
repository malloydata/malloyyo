// Shared model-runner host for the local dashboard preview server.
//
// Mirrors `mcp.ts`'s runtime construction (core config discovery, fs reader,
// prepareSource, per-call connection idling) but exposes a plain
// `run(queryName, givens)` the dashboard bridge calls. The engine stays pure
// logic over an injected Runtime; this file is the HOST that owns the Runtime.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import {
  MalloyConfig,
  Runtime,
  discoverConfig,
  type GivenValue,
  type URLReader,
} from "@malloydata/malloy";
import {
  artifactQueries,
  dashboardGivenSpecs,
  prepareSource,
  run,
  runRestricted,
  validateRestricted,
  type ArtifactsResult,
  type DashboardGivenSpec,
  type DashboardGivenSpecsResult,
  type RunResult,
} from "@malloyyo/mcp-engine";

export type ValidateResult = { ok: true } | { ok: false; error: string };

// The dashboard control contract, read from the MODEL's given: declarations —
// shared with the hosted serving path via mcp-engine so the two can't drift.
export type GivenSpec = DashboardGivenSpec;
export type GivenSpecsResult = DashboardGivenSpecsResult;

const ENTRY = "index.malloy";

/** Local files only — the preview server serves THIS project, not the disk. */
function fsReader(): URLReader {
  return {
    readURL: async (u: URL) => {
      if (u.protocol !== "file:") {
        throw new Error(`unsupported URL scheme for import: ${u.href}`);
      }
      return fs.promises.readFile(u, "utf8");
    },
  };
}

/** core's own config discovery (malloy-config[.local].json), else a bare
    DuckDB world — same fallback the hosted server and `malloyyo mcp` use. */
async function loadConfig(rootUrl: URL, reader: URLReader): Promise<MalloyConfig> {
  const discovered = await discoverConfig(rootUrl, rootUrl, reader).catch(() => null);
  return (
    discovered ??
    new MalloyConfig({ includeDefaultConnections: true } as never, {
      rootDirectory: rootUrl.toString(),
    })
  );
}

export interface ModelRunner {
  /** Run a dashboard's run-expression (a top-level query name or a
      `<source> -> <view>` path) with the given filter values (the givens). */
  run(runExpr: string, givens: Record<string, unknown>): Promise<RunResult>;
  /** Run restricted Malloy query text (core's restricted mode is the gate: no
      import / given: / connection.* / raw SQL / ##! flags). This is how
      dashboards run suggestion queries and ad-hoc panels. */
  runText(malloy: string, givens: Record<string, unknown>): Promise<RunResult>;
  /** Compile-only check of restricted query text (no execution). */
  validateText(malloy: string): Promise<ValidateResult>;
  /** Compile-only: does the run-expression compile and do the givens bind? No
      data fetch — used by `lint` to catch drift (unknown given, missing
      query/view). */
  validate(runExpr: string, givens: Record<string, unknown>): Promise<ValidateResult>;
  /** The given specs a dashboard's run-expression transitively references —
      read from the model's `given:` declarations (types, defaults, doc
      comments, tags). */
  givensForQuery(runExpr: string): Promise<GivenSpecsResult>;
  /** Same, but compiled against an ALTERNATE project file (a peer .malloy)
      instead of index.malloy. lint uses this to learn the givens a dashboard
      references from its source's DEFINING file — including givens
      index.malloy doesn't re-export, whose controls silently won't render. */
  givensForQueryIn(entryFile: string, runExpr: string): Promise<GivenSpecsResult>;
  /** The model's `# artifact`-tagged queries — its declared dashboards. */
  artifacts(): Promise<ArtifactsResult>;
  entryExists(): boolean;
  /** Close the shared connections for good (release sockets/file locks, drop
      the schema cache). Call at end of a short-lived command (e.g. `lint`) so
      the process can exit promptly; long-lived hosts can rely on process exit. */
  dispose(): Promise<void>;
  root: string;
}

export async function makeRunner(root: string): Promise<ModelRunner> {
  // Registers connection types; MUST run before any MalloyConfig is built.
  await import("@malloydata/malloy-connections");
  const abs = path.resolve(root);
  const rootUrl = url.pathToFileURL(abs + path.sep);

  // ONE long-lived config/connection set for the whole runner. Reusing it
  // across leases is what keeps each connection's in-memory schema cache warm:
  // a fresh MalloyConfig per call (as this used to do) builds fresh connections
  // with empty caches, so every compile re-fetches every table's schema cold —
  // turning a BigQuery-backed `lint` (dozens of compiles) into minutes of
  // repeated schema fetches that read like a hang. The base reader is stateless
  // (prepareSource layers its own per-entry cache over it), so it's shared too.
  const reader = fsReader();
  let configPromise: Promise<MalloyConfig> | null = null;
  const getConfig = () => (configPromise ??= loadConfig(rootUrl, reader));

  // Release connections to 'idle' only when no lease is in flight. 'idle'
  // frees sockets/file locks (so a long-lived host doesn't hold them, and the
  // process can exit) while PRESERVING the schema cache on the reused config;
  // gating on inFlight keeps a concurrent lease from idling connections another
  // is mid-compile on.
  let inFlight = 0;

  // Per-call lease: fresh runtime over the shared config. `entryFile` is the
  // model file compiled against — index.malloy for the real serving surface, or
  // a peer .malloy when lint needs a source's own scope.
  async function leaseIn<T>(
    entryFile: string,
    fn: (runtime: Runtime, entry: URL) => Promise<T>,
  ): Promise<T> {
    const config = await getConfig();
    const { reader: prepared, entry } = prepareSource(reader, { url: path.join(abs, entryFile) });
    const runtime = new Runtime({ config, urlReader: prepared });
    inFlight++;
    try {
      return await fn(runtime, entry);
    } finally {
      inFlight--;
      if (inFlight === 0) await config.shutdown("idle").catch(() => {});
    }
  }
  const lease = <T>(fn: (runtime: Runtime, entry: URL) => Promise<T>): Promise<T> =>
    leaseIn(ENTRY, fn);

  return {
    root: abs,
    entryExists: () => fs.existsSync(path.join(abs, ENTRY)),
    async dispose() {
      if (!configPromise) return;
      const config = await configPromise.catch(() => null);
      configPromise = null;
      if (config) await config.shutdown("close").catch(() => {});
    },
    run(runExpr, givens) {
      return lease((runtime, entry) =>
        run(runtime, entry, { runExpr, givens, stableResult: true, rowLimit: 5000 }),
      );
    },
    runText(malloy, givens) {
      return lease((runtime, entry) =>
        runRestricted(runtime, entry, malloy, { givens, stableResult: true, rowLimit: 5000 }),
      );
    },
    validateText(malloy) {
      return lease(async (runtime, entry) => {
        const v = await validateRestricted(runtime, entry, malloy);
        if (v.ok) return { ok: true };
        const msg = v.problems
          .filter((p) => p.severity === "error")
          .map((p) => p.message)
          .join("; ");
        return { ok: false, error: msg || "restricted query failed to compile" };
      });
    },
    givensForQuery(runExpr) {
      return lease((runtime, entry) => dashboardGivenSpecs(runtime, entry, runExpr));
    },
    givensForQueryIn(entryFile, runExpr) {
      return leaseIn(entryFile, (runtime, entry) => dashboardGivenSpecs(runtime, entry, runExpr));
    },
    artifacts() {
      return lease((runtime, entry) => artifactQueries(runtime, entry));
    },
    validate(runExpr, givens) {
      return lease(async (runtime, entry) => {
        try {
          // Compile `run: <runExpr>` — accepts a query name or `<source> ->
          // <view>`. A bad name/view surfaces as the compiler's own error.
          const q = runtime.loadModel(entry).loadQuery(`run: ${runExpr}`);
          const has = givens && Object.keys(givens).length > 0;
          await q.getSQL(has ? { givens: givens as Record<string, GivenValue> } : undefined);
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      });
    },
  };
}
