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
import { prepareSource, run, type RunResult } from "@malloyyo/mcp-engine";

export type ValidateResult = { ok: true } | { ok: false; error: string };

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
  /** Compile-only: does the named query exist and do the givens bind? No data
      fetch — used by `lint` to catch drift (unknown given, missing query). */
  validate(queryName: string, givens: Record<string, unknown>): Promise<ValidateResult>;
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
