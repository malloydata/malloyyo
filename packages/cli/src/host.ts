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
  type URLReader,
} from "@malloydata/malloy";
import { prepareSource, run, type RunResult } from "@malloyyo/mcp-engine";

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
  entryExists(): boolean;
  root: string;
}

export async function makeRunner(root: string): Promise<ModelRunner> {
  // Registers connection types; MUST run before any MalloyConfig is built.
  await import("@malloydata/malloy-connections");
  const abs = path.resolve(root);
  const rootUrl = url.pathToFileURL(abs + path.sep);

  return {
    root: abs,
    entryExists: () => fs.existsSync(path.join(abs, ENTRY)),
    async run(queryName, givens) {
      const reader = fsReader();
      const config = await loadConfig(rootUrl, reader);
      const { reader: prepared, entry } = prepareSource(reader, {
        url: path.join(abs, ENTRY),
      });
      const runtime = new Runtime({ config, urlReader: prepared });
      try {
        return await run(runtime, entry, {
          name: queryName,
          givens,
          stableResult: true,
          rowLimit: 5000,
        });
      } finally {
        await config.shutdown("idle").catch(() => {});
      }
    },
  };
}
