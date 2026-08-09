// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Open a compiled-model blob and present it to the engine as an ExploreHost.
//
// The premise this file rests on: a ModelDef is ALREADY fully compiled — every
// table's schema is baked into it — so re-opening one needs no database driver,
// no credentials and no network. Malloy still asks a connection for its
// dialect when it generates SQL, so we hand it a nameplate: a Connection that
// answers `dialectName` and throws on everything else. If that throw ever
// fires, the no-driver premise has broken and we want to know loudly rather
// than to quietly grow a dependency on a real driver.

import { readFileSync } from 'node:fs';
import { Runtime, type Connection } from '@malloydata/malloy';
import {
  compile,
  decodeModelBlob,
  modelCatalogEntry,
  modelConnections,
  rehydrateModel,
  type ExploreHost,
  type ModelBlob,
  type ModelList,
} from '@malloyyo/mcp-engine';

/** The synthetic entry URL a rehydrated model answers to. Nothing reads it —
    the model never comes from a file here — but the engine addresses models by
    URL, so it needs a stable one. */
export const ENTRY = new URL('file:///model.malloy');

export class ClientError extends Error {}

/** What a compile-only client is allowed to ask a connection for. */
function nameplateConnection(name: string, dialect: string): Connection {
  const refuse = (what: string) => (): never => {
    throw new ClientError(
      `malloyyo_client is compile-only and cannot ${what}. The model is already ` +
        'compiled, so schemas and results both live on the server — run this query ' +
        'there with the `query` MCP tool.',
    );
  };
  const conn = {
    name,
    dialectName: dialect,
    get isPool() { return false; },
    get isStreaming() { return false; },
    runSQL: refuse('execute SQL'),
    fetchSchemaForTables: refuse('fetch table schemas'),
    fetchSchemaForSQLStruct: refuse('fetch SQL-block schemas'),
    estimateQueryCost: refuse('estimate query cost'),
    close: () => Promise.resolve(),
  };
  // The Connection interface carries driver-facing members a nameplate has no
  // business implementing; this cast is the one place that asymmetry is stated.
  return conn as unknown as Connection;
}

export interface LoadedModel {
  /** The engine host — feeds `exploreSurface` exactly as the server's does. */
  host: ExploreHost;
  /** Envelope metadata, for `info` and for version reporting. */
  blob: ModelBlob;
}

export interface OpenOptions {
  /** Local development only — see DecodeOptions.allowVersionMismatch. */
  allowVersionMismatch?: boolean;
  /** Where a version warning goes. Defaults to stderr, so it never pollutes the
      JSON on stdout that a caller is parsing. */
  warn?: (message: string) => void;
}

/** Decode a blob and stand up a rehydrated, driver-free model. */
export function openModelBlob(input: unknown, opts: OpenOptions = {}): LoadedModel {
  const decoded = decodeModelBlob(input, { allowVersionMismatch: opts.allowVersionMismatch });
  if (!decoded.ok) throw new ClientError(decoded.error);
  const { def, blob } = decoded;
  const warn = opts.warn ?? ((m: string) => process.stderr.write(m + '\n'));
  for (const w of decoded.warnings ?? []) {
    warn(`malloyyo_client: WARNING (version check off) ${w}`);
  }

  const conns = modelConnections(def);
  const stubs = new Map<string, Connection>(
    [...conns].map(([name, dialect]) => [name, nameplateConnection(name, dialect)]),
  );
  // A model with no connection at all still has to resolve *something*, and a
  // name we were never told about is a model we cannot faithfully compile — so
  // fall back to a lone connection when there is exactly one, and refuse
  // otherwise rather than guess a dialect and emit wrong SQL.
  const only = stubs.size === 1 ? [...stubs.values()][0] : undefined;

  const runtime = new Runtime({
    urlReader: {
      readURL: (url: URL) =>
        Promise.reject(
          new ClientError(
            `malloyyo_client has no source files (tried to read ${url.href}). ` +
              'A compiled model carries no .malloy text.',
          ),
        ),
    },
    connections: {
      lookupConnection: (name?: string) => {
        const found = name ? stubs.get(name) : only;
        if (found) return Promise.resolve(found);
        if (!name && only) return Promise.resolve(only);
        return Promise.reject(
          new ClientError(
            `this model references connection '${name ?? '(default)'}', which is not ` +
              `in the compiled model (found: ${[...stubs.keys()].join(', ') || 'none'}). ` +
              'Re-fetch the model blob.',
          ),
        );
      },
    },
  });

  // The engine calls runtime.loadModel(ENTRY) itself, so shadow that one URL to
  // return the rehydrated materializer. Same technique the server uses for its
  // durable ModelDef cache (src/lib/malloy.ts) — the engine stays unaware that
  // it is working from a def rather than from source.
  const original = runtime.loadModel.bind(runtime);
  Object.defineProperty(runtime, 'loadModel', {
    configurable: true,
    writable: true,
    value: (url: URL, options?: unknown) =>
      url.href === ENTRY.href
        ? rehydrateModel(runtime, def)
        : (original as (u: URL, o?: unknown) => unknown)(url, options),
  });

  const bound = { runtime, entry: ENTRY };
  const modelRef = blob.model_ref;

  const host: ExploreHost = {
    withModel: async (ref, fn) => {
      // One model per blob. A wrong ref is a real mistake (the agent is aiming
      // at another dataset), so say which one this file holds.
      if (ref !== modelRef) {
        throw new ClientError(
          `this model file holds '${modelRef}', not '${ref}'. ` +
            'Fetch that model into its own file and point --model at it.',
        );
      }
      return fn(bound);
    },
    list: async (): Promise<ModelList> => {
      const compiled = await compile(runtime, ENTRY, { exportedOnly: true });
      if (!compiled.ok || !compiled.model) return { entries: [{ model_ref: modelRef }] };
      return { entries: [modelCatalogEntry(modelRef, compiled.model)] };
    },
  };

  return { host, blob };
}

/** Read a blob from a file (or `-` for stdin) and open it. */
export function openModelFile(path: string, opts: OpenOptions = {}): LoadedModel {
  let text: string;
  try {
    text = readFileSync(path === '-' ? 0 : path, 'utf8');
  } catch (e) {
    throw new ClientError(
      `cannot read model file '${path}': ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return openModelBlob(text, opts);
}
