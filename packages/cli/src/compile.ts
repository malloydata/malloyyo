// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// `malloyyo compile` — compile the local model once and write the compiled
// ModelDef out as a blob, so `malloyyo_client` can answer questions about it
// without a database, a network, or this CLI's 600-package dependency tree.
//
// This is the local twin of the hosted `fetch_compiled_model` MCP tool: same
// envelope, same version stamping, so a blob from either producer opens in the
// same client. Compiling is the expensive half (it fetches every source's
// schema); doing it once here is what makes the client's job cheap.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import {
  MalloyConfig,
  Runtime,
  discoverConfig,
  type URLReader,
} from "@malloydata/malloy";
import {
  encodeModelBlob,
  extractModelDef,
  mapProblems,
  type Problem,
} from "@malloyyo/mcp-engine";
import { initConnections, warnConnectionIssues, withConnectionDiagnostics } from "./connections.js";

const ENTRY = "index.malloy";

/** Local files only — this compiles THIS project, not the disk. */
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

/** core's own config discovery (malloy-config[.local].json), else a bare DuckDB
    world — the same fallback `malloyyo mcp` and the hosted server use. */
async function loadConfig(rootUrl: URL, reader: URLReader): Promise<MalloyConfig> {
  const discovered = await discoverConfig(rootUrl, rootUrl, reader).catch(() => null);
  return (
    discovered ??
    new MalloyConfig({ includeDefaultConnections: true } as never, {
      rootDirectory: rootUrl.toString(),
    })
  );
}

function formatProblem(p: Problem): string {
  const at = p.line !== undefined ? `:${p.line + 1}${p.column !== undefined ? `:${p.column + 1}` : ""}` : "";
  return `  ${p.severity}${at} ${p.message}`;
}

export interface CompileCmdOptions {
  /** Output path; `-` writes to stdout. */
  output?: string;
  root?: string;
  /** Name the blob carries; the client reports it and matches model_ref on it. */
  modelRef?: string;
  /** Client version to stamp. Defaults to this CLI's version (they release
      together), which is what makes the two halves impossible to mismatch. */
  clientVersion: string;
}

export async function compileCmd(opts: CompileCmdOptions): Promise<void> {
  const root = path.resolve(opts.root ?? ".");
  const entryPath = path.join(root, ENTRY);
  if (!fs.existsSync(entryPath)) {
    throw new Error(`no ${ENTRY} in ${root} — run this from a model repo, or pass -C <dir>.`);
  }

  // Register the bundled connection drivers before config discovery — without
  // this even the default DuckDB world resolves to "no connection named duckdb".
  warnConnectionIssues(await initConnections());

  const rootUrl = url.pathToFileURL(root + path.sep);
  const reader = fsReader();
  const config = await loadConfig(rootUrl, reader);
  try {
    const runtime = new Runtime({ config, urlReader: reader });
    const model = await withConnectionDiagnostics(() =>
      runtime.loadModel(url.pathToFileURL(entryPath)).getModel(),
    );

    // Warnings are worth seeing but do not block: the model compiled, so the
    // blob is valid. Errors would have thrown out of getModel().
    const problems = mapProblems(model.problems);
    for (const p of problems) process.stderr.write(formatProblem(p) + "\n");

    const blob = encodeModelBlob(extractModelDef(model), {
      model_ref: opts.modelRef ?? path.basename(root),
      client_version: opts.clientVersion,
    });
    const json = JSON.stringify(blob);

    if (!opts.output || opts.output === "-") {
      process.stdout.write(json + "\n");
      return;
    }
    fs.writeFileSync(opts.output, json);
    const pct = ((blob.payload.length / blob.bytes) * 100).toFixed(1);
    process.stderr.write(
      `✓ ${opts.output} — model '${blob.model_ref}', ` +
        `${(blob.bytes / 1024).toFixed(0)}KB compiled → ${(blob.payload.length / 1024).toFixed(1)}KB blob (${pct}%)\n` +
        `  malloyyo_client --model ${opts.output} list_sources\n`,
    );
  } finally {
    await config.shutdown("close");
  }
}
