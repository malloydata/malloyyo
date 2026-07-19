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
  collectDrillTargets,
  dashboardGivenSpecs,
  tileSchema,
  modelArtifact,
  prepareSource,
  run,
  runRestricted,
  validateRestricted,
  type ArtifactInfo,
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

/** One tile in a composite dashboard, as the frame's renderer needs it: the
    run-expression, the card name, the given NAMES the tile references (so it runs
    with only those — binding an unreferenced given fails the compile), and its
    schema-only result (compiled, no data) so the frame can reserve the tile's slot
    in the layout before its data arrives. */
export interface TileSpec {
  run: string;
  name: string;
  givens: string[];
  schema?: unknown;
}

const ENTRY = "index.malloy";

// How long the runner stays quiet (no leases) before releasing connections to
// 'idle'. Long enough to keep a network connection (MotherDuck/BigQuery) warm
// across a dashboard's tile fan-out and rapid reloads; short enough that a
// walked-away server eventually frees its sockets.
const IDLE_SHUTDOWN_MS = 60_000;

/** Card name for a tile run-expression: the view name from `source -> view`,
    else the query name. */
function tileName(runExpr: string): string {
  const arrow = runExpr.lastIndexOf("->");
  return (arrow >= 0 ? runExpr.slice(arrow + 2) : runExpr).trim();
}

/** Compile-only check of `run: <runExpr>` against a loaded model — no data
    fetch. A bad name/view/given surfaces as the compiler's own error. */
async function validateQuery(
  runtime: Runtime,
  entry: URL,
  runExpr: string,
  givens?: Record<string, unknown>,
): Promise<ValidateResult> {
  try {
    const q = runtime.loadModel(entry).loadQuery(`run: ${runExpr}`);
    const has = givens && Object.keys(givens).length > 0;
    await q.getSQL(has ? { givens: givens as Record<string, GivenValue> } : undefined);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Compile-only check of restricted Malloy text against a loaded model. */
async function validateRestrictedText(
  runtime: Runtime,
  entry: URL,
  malloy: string,
): Promise<ValidateResult> {
  const v = await validateRestricted(runtime, entry, malloy);
  if (v.ok) return { ok: true };
  const msg = v.problems
    .filter((p) => p.severity === "error")
    .map((p) => p.message)
    .join("; ");
  return { ok: false, error: msg || "restricted query failed to compile" };
}

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
  /** Run a run-expression against a specific `entryFile` (a dashboard's own
      file) — a component's `<Panel query=…>`/`<VegaChart query=…>` whose query
      is defined in the dashboard file, not index.malloy. */
  runIn(entryFile: string, runExpr: string, givens: Record<string, unknown>): Promise<RunResult>;
  /** Run restricted Malloy query text (core's restricted mode is the gate: no
      import / given: / connection.* / raw SQL / ##! flags). This is how
      dashboards run suggestion queries and ad-hoc panels. */
  runText(malloy: string, givens: Record<string, unknown>): Promise<RunResult>;
  /** Same, compiled against a specific `entryFile` (a dashboard's own file). */
  runTextIn(entryFile: string, malloy: string, givens: Record<string, unknown>): Promise<RunResult>;
  /** Compile-only check of restricted query text (no execution). */
  validateText(malloy: string): Promise<ValidateResult>;
  /** Same, compiled against a specific `entryFile` (a dashboard's own file). */
  validateTextIn(entryFile: string, malloy: string): Promise<ValidateResult>;
  /** Compile-only: does the run-expression compile and do the givens bind? No
      data fetch — used by `lint` to catch drift (unknown given, missing
      query/view). */
  validate(runExpr: string, givens: Record<string, unknown>): Promise<ValidateResult>;
  /** Same, compiled against a specific `entryFile` (a dashboard's own file) —
      lint validates each tile against the dashboard file that declares it. */
  validateIn(entryFile: string, runExpr: string, givens?: Record<string, unknown>): Promise<ValidateResult>;
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
  /** Dashboard slugs referenced by `# drill { to=[…] }` tags on the model's
      source dimensions (compiled from index.malloy), excluding `self`. Lint
      checks each resolves to a discovered dashboard. */
  drillTargets(): Promise<{ ok: true; targets: string[] } | { ok: false; error: string }>;
  /** Structure v2: read the `## artifact` a `dashboards/<name>.malloy` file
      declares, compiling that file AS the entry. `entryFile` is relative to the
      project root; `defaultName` (the basename) names it when the tag omits
      `name=`. */
  artifactForFile(
    entryFile: string,
    defaultName: string,
  ): Promise<{ ok: true; artifact?: ArtifactInfo } | { ok: false; error: string }>;
  /** The UNION of given specs across a composite's tiles, resolved in the
      dashboard file's own scope — the controls the dashboard shows. */
  dashboardGivens(entryFile: string, tiles: string[]): Promise<GivenSpecsResult>;
  /** Per-tile specs the frame's composite renderer needs: each tile's
      run-expression, card name, and the NAMES of the givens it references (so the
      frame runs each tile with only those — binding an unreferenced given fails
      the compile). `union` is the deduped given specs across all tiles (the
      controls). One compile per tile; the model schema cache is reused. */
  dashboardTiles(
    entryFile: string,
    tiles: string[],
  ): Promise<{ ok: true; tiles: TileSpec[]; union: GivenSpec[] }>;
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
  //
  // But 'idle' also tears down a NETWORK connection (MotherDuck/BigQuery/…), and
  // re-attaching it on the next request is expensive — for MotherDuck a cold
  // reconnect is many seconds. A dashboard with N tiles fires N requests, and any
  // gap between loads would pay that reconnect again. So we DEBOUNCE the idle
  // release: only shut down after a quiet period with no leases, which keeps the
  // connection warm across a dashboard's tile fan-out and rapid reloads while
  // still releasing sockets when the server is genuinely idle.
  let inFlight = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const scheduleIdleShutdown = () => {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (inFlight === 0) void getConfig().then((c) => c.shutdown("idle").catch(() => {}));
    }, IDLE_SHUTDOWN_MS);
    // Don't let the debounce timer keep the process alive on its own.
    idleTimer.unref?.();
  };

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
    clearIdleTimer();
    try {
      return await fn(runtime, entry);
    } finally {
      inFlight--;
      if (inFlight === 0) scheduleIdleShutdown();
    }
  }
  const lease = <T>(fn: (runtime: Runtime, entry: URL) => Promise<T>): Promise<T> =>
    leaseIn(ENTRY, fn);

  return {
    root: abs,
    entryExists: () => fs.existsSync(path.join(abs, ENTRY)),
    async dispose() {
      clearIdleTimer();
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
    runIn(entryFile, runExpr, givens) {
      return leaseIn(entryFile, (runtime, entry) =>
        run(runtime, entry, { runExpr, givens, stableResult: true, rowLimit: 5000 }),
      );
    },
    runText(malloy, givens) {
      return lease((runtime, entry) =>
        runRestricted(runtime, entry, malloy, { givens, stableResult: true, rowLimit: 5000 }),
      );
    },
    runTextIn(entryFile, malloy, givens) {
      return leaseIn(entryFile, (runtime, entry) =>
        runRestricted(runtime, entry, malloy, { givens, stableResult: true, rowLimit: 5000 }),
      );
    },
    validateText(malloy) {
      return lease((runtime, entry) => validateRestrictedText(runtime, entry, malloy));
    },
    validateTextIn(entryFile, malloy) {
      return leaseIn(entryFile, (runtime, entry) => validateRestrictedText(runtime, entry, malloy));
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
    drillTargets() {
      return lease((runtime, entry) => collectDrillTargets(runtime, entry));
    },
    artifactForFile(entryFile, defaultName) {
      return leaseIn(entryFile, (runtime, entry) => modelArtifact(runtime, entry, defaultName));
    },
    dashboardGivens(entryFile, tiles) {
      return leaseIn(entryFile, async (runtime, entry) => {
        // Union by name — a given is declared once at model scope, so the first
        // tile that references it carries the authoritative spec.
        const byName = new Map<string, DashboardGivenSpec>();
        for (const tile of tiles) {
          const specs = await dashboardGivenSpecs(runtime, entry, tile);
          if (specs.ok) for (const s of specs.givens) if (!byName.has(s.name)) byName.set(s.name, s);
        }
        return { ok: true, givens: [...byName.values()] };
      });
    },
    dashboardTiles(entryFile, tiles) {
      return leaseIn(entryFile, async (runtime, entry) => {
        const byName = new Map<string, DashboardGivenSpec>();
        const out: TileSpec[] = [];
        for (const tile of tiles) {
          const specs = await dashboardGivenSpecs(runtime, entry, tile);
          const gvs = specs.ok ? specs.givens : [];
          for (const s of gvs) if (!byName.has(s.name)) byName.set(s.name, s);
          const schema = await tileSchema(runtime, entry, tile);
          out.push({
            run: tile,
            name: tileName(tile),
            givens: gvs.map((s) => s.name),
            ...(schema ? { schema } : {}),
          });
        }
        return { ok: true, tiles: out, union: [...byName.values()] };
      });
    },
    validate(runExpr, givens) {
      return lease((runtime, entry) => validateQuery(runtime, entry, runExpr, givens));
    },
    validateIn(entryFile, runExpr, givens) {
      return leaseIn(entryFile, (runtime, entry) => validateQuery(runtime, entry, runExpr, givens));
    },
  };
}
