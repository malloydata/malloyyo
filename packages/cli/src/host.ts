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
  /** Run a top-level named query with the given filter values (the givens). */
  run(queryName: string, givens: Record<string, unknown>): Promise<RunResult>;
  /** Run restricted Malloy query text (core's restricted mode is the gate: no
      import / given: / connection.* / raw SQL / ##! flags). This is how
      dashboards run suggestion queries and ad-hoc panels. */
  runText(malloy: string, givens: Record<string, unknown>): Promise<RunResult>;
  /** Compile-only check of restricted query text (no execution). */
  validateText(malloy: string): Promise<ValidateResult>;
  /** Compile-only: does the named query exist and do the givens bind? No data
      fetch — used by `lint` to catch drift (unknown given, missing query). */
  validate(queryName: string, givens: Record<string, unknown>): Promise<ValidateResult>;
  /** The given specs a named query transitively references — read from the
      model's `given:` declarations (types, defaults, doc comments, tags). */
  givensForQuery(queryName: string): Promise<GivenSpecsResult>;
  /** The model's `# artifact`-tagged queries — its declared dashboards. */
  artifacts(): Promise<ArtifactsResult>;
  entryExists(): boolean;
  root: string;
}

export async function makeRunner(root: string): Promise<ModelRunner> {
  // Registers connection types; MUST run before any MalloyConfig is built.
  await import("@malloydata/malloy-connections");
  const abs = path.resolve(root);
  const rootUrl = url.pathToFileURL(abs + path.sep);

  // Per-call lease: fresh runtime over the current config, idled after use.
  async function lease<T>(fn: (runtime: Runtime, entry: URL) => Promise<T>): Promise<T> {
    const reader = fsReader();
    const config = await loadConfig(rootUrl, reader);
    const { reader: prepared, entry } = prepareSource(reader, { url: path.join(abs, ENTRY) });
    const runtime = new Runtime({ config, urlReader: prepared });
    try {
      return await fn(runtime, entry);
    } finally {
      await config.shutdown("idle").catch(() => {});
    }
  }

  return {
    root: abs,
    entryExists: () => fs.existsSync(path.join(abs, ENTRY)),
    run(queryName, givens) {
      return lease((runtime, entry) =>
        run(runtime, entry, { name: queryName, givens, stableResult: true, rowLimit: 5000 }),
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
    givensForQuery(queryName) {
      return lease((runtime, entry) => dashboardGivenSpecs(runtime, entry, queryName));
    },
    artifacts() {
      return lease((runtime, entry) => artifactQueries(runtime, entry));
    },
    validate(queryName, givens) {
      return lease(async (runtime, entry) => {
        try {
          const mm = runtime.loadModel(entry);
          const model = await mm.getModel();
          const named = [...model.queries().named];
          if (!named.includes(queryName)) {
            return { ok: false, error: `no query named '${queryName}' (model has: ${named.join(", ") || "none"})` };
          }
          const q = mm.loadQueryByName(queryName);
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
