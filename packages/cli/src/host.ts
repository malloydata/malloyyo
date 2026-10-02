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
  declaredGivenNames,
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
  readDatasetMeta,
  type DatasetMeta,
} from "@malloyyo/mcp-engine";
import { initConnections, withConnectionDiagnostics } from "./connections.js";
import {
  missingServerGivensMessage,
  readServerGivens,
  serverFilledNames,
} from "./server-givens.js";

export type ValidateResult = { ok: true } | { ok: false; error: string };

// The dashboard control contract, read from the MODEL's given: declarations —
// shared with the hosted serving path via mcp-engine so the two can't drift.
export type GivenSpec = DashboardGivenSpec;
export type GivenSpecsResult = DashboardGivenSpecsResult;

/** One tile in a composite dashboard, as the frame's renderer needs it: the
    run-expression, the card name, and the given NAMES the tile references (so it
    runs with only those — binding an unreferenced given fails the compile). */
export interface TileSpec {
  run: string;
  name: string;
  givens: string[];
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
/**
 * `malloy-config.json`, found by walking UP from the model root to `ceilingUrl`.
 *
 * The ceiling matters for a multi-dataset repo. Connections belong to the REPO
 * and the config sits at its root, but a dataset's model root is
 * `datasets/<name>/` — so searching only there finds nothing, every connection
 * the repo declares is missing, and `lint` fails on a repo the server publishes
 * happily. Passing the same URL for both (which this did) is the single-dataset
 * case, where the repo root and the model root are the same directory.
 */
async function loadConfig(rootUrl: URL, reader: URLReader, ceilingUrl = rootUrl): Promise<MalloyConfig> {
  const discovered = await discoverConfig(rootUrl, ceilingUrl, reader).catch(() => null);
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
  /** `## dataset { title= }` from the entry model, when it declares one. The
      CLI reports it so an author sees what their dataset will be called before
      they publish it. */
  datasetMeta(): Promise<DatasetMeta>;
  /** Close the shared connections for good (release sockets/file locks, drop
      the schema cache). Call at end of a short-lived command (e.g. `lint`) so
      the process can exit promptly; long-lived hosts can rely on process exit. */
  dispose(): Promise<void>;
  root: string;
}

export async function makeRunner(
  root: string,
  /** `repoRoot`: the directory the config search may walk up to. A dataset in a
      multi-dataset repo has its model root under `datasets/`, and the config it
      needs is at the repo root above it. Defaults to `root` — the
      single-dataset case, where they are the same place. */
  opts: { repoRoot?: string } = {},
): Promise<ModelRunner> {
  // Registers connection types and verifies the registry we read is the one
  // that was written to; MUST run before any MalloyConfig is built.
  await initConnections();
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
  const ceilingUrl = opts.repoRoot
    ? url.pathToFileURL(path.resolve(opts.repoRoot) + path.sep)
    : rootUrl;
  const getConfig = () => (configPromise ??= loadConfig(rootUrl, reader, ceilingUrl));

  // Local stand-ins for the givens a Malloyyo server fills — read from the
  // ENVIRONMENT, per model, on first use. Lazy because it needs the model's
  // declarations, which needs a compile; cached because every lease wants it.
  //
  // A missing variable throws rather than defaulting: a tenant-scoped dashboard
  // that renders empty is indistinguishable from a broken one, and the whole
  // point of running locally is to see what a reader will see.
  let scopePromise: Promise<{
    givens: Record<string, GivenValue>;
    finalize: string[];
    missing: string[];
  }> | null = null;
  const givenScope = () =>
    (scopePromise ??= (async () => {
      // No entry, or an entry that won't compile: nothing to read declarations
      // from. Both are ordinary here — a repo can be landing-page-only, and a
      // broken model is the normal state mid-edit — and in both cases the run
      // that follows reports the real problem far better than a scope error
      // would. Locally that is a fair trade: the author is the only reader.
      if (!fs.existsSync(path.join(abs, ENTRY))) return { givens: {}, finalize: [], missing: [] };
      const config = await getConfig();
      const { reader: prepared, entry } = prepareSource(reader, { url: path.join(abs, ENTRY) });
      let model;
      try {
        model = await new Runtime({ config, urlReader: prepared }).loadModel(entry).getModel();
      } catch {
        return { givens: {}, finalize: [], missing: [] };
      }
      const declared = serverFilledNames(declaredGivenNames(model));
      if (declared.length === 0) return { givens: {}, finalize: [], missing: [] };
      // Reported, not thrown: `lint`, artifact discovery and the dashboard
      // bundler all compile without ever running a query, and none of them
      // needs to know who is asking. Only the run paths below refuse.
      const found = readServerGivens(declared);
      // NOT finalized locally: `finalizeGivens` lives in the config file, and the
      // config here is the author's own. So a `?MALLOYYO_EMAIL=` in the dev URL
      // still overrides — which is the right local affordance (look at the page
      // as someone else) and exactly what a published instance forbids. The
      // thing that must match production is the GATE below, and it does.
      return { givens: found.givens, finalize: declared, missing: found.missing };
    })());

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
    const { givens: scoped } = await givenScope();
    const runtime = new Runtime({
      config,
      urlReader: prepared,
      ...(Object.keys(scoped).length > 0 ? { givens: scoped } : {}),
    } as ConstructorParameters<typeof Runtime>[0]);
    inFlight++;
    clearIdleTimer();
    try {
      // A missing connection surfaces from deep inside a compile; annotate it
      // here, the one choke point every lease passes through.
      return await withConnectionDiagnostics(() => fn(runtime, entry));
    } finally {
      inFlight--;
      if (inFlight === 0) scheduleIdleShutdown();
    }
  }
  const lease = <T>(fn: (runtime: Runtime, entry: URL) => Promise<T>): Promise<T> =>
    leaseIn(ENTRY, fn);

  /** The scope, for a path that is about to RUN something. Refuses when a
      declared server given has no local stand-in — a tenant-scoped page that
      renders empty is indistinguishable from a broken one. */
  const runnableScope = async () => {
    const scope = await givenScope();
    if (scope.missing.length > 0) throw new Error(missingServerGivensMessage(scope.missing));
    return scope;
  };



  return {
    root: abs,
    entryExists: () => fs.existsSync(path.join(abs, ENTRY)),
    datasetMeta: async () => {
      if (!fs.existsSync(path.join(abs, ENTRY))) return {};
      try {
        const config = await getConfig();
        const { reader: prepared, entry } = prepareSource(reader, { url: path.join(abs, ENTRY) });
        const model = await new Runtime({ config, urlReader: prepared }).loadModel(entry).getModel();
        return readDatasetMeta(model);
      } catch {
        // A model that will not compile has a title nobody can read yet; lint
        // reports the compile failure, which is the useful message.
        return {};
      }
    },
    async dispose() {
      clearIdleTimer();
      if (!configPromise) return;
      const config = await configPromise.catch(() => null);
      configPromise = null;
      if (config) await config.shutdown("close").catch(() => {});
    },
    async run(runExpr, givens) {
      const { finalize } = await runnableScope();
      return lease((runtime, entry) =>
        run(runtime, entry, { runExpr, givens, requireGivens: finalize, stableResult: true, rowLimit: 5000 }),
      );
    },
    async runIn(entryFile, runExpr, givens) {
      const { finalize } = await runnableScope();
      return leaseIn(entryFile, (runtime, entry) =>
        run(runtime, entry, { runExpr, givens, requireGivens: finalize, stableResult: true, rowLimit: 5000 }),
      );
    },
    async runText(malloy, givens) {
      const { finalize } = await runnableScope();
      return lease((runtime, entry) =>
        runRestricted(runtime, entry, malloy, { givens, requireGivens: finalize, stableResult: true, rowLimit: 5000 }),
      );
    },
    async runTextIn(entryFile, malloy, givens) {
      const { finalize } = await runnableScope();
      return leaseIn(entryFile, (runtime, entry) =>
        runRestricted(runtime, entry, malloy, { givens, requireGivens: finalize, stableResult: true, rowLimit: 5000 }),
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
          out.push({
            run: tile,
            name: tileName(tile),
            givens: gvs.map((s) => s.name),
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
