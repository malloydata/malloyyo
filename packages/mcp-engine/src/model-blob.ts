// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The compiled-model blob: a self-contained, compressed envelope carrying a
// fully-compiled ModelDef from wherever it was compiled (the hosted server, or
// `malloyyo compile`) to wherever it is used (malloyyo_client).
//
// WHY A BLOB AND NOT A URL: the consumer may be a container that can reach
// nothing but the MCP endpoint it was handed, so the model has to travel inside
// the tool RESULT. That makes size the whole design constraint — the envelope
// is brotli'd precisely because a raw ModelDef is enormous (a 6-source model
// measures ~355KB of JSON, ~91k tokens) while the same bytes brotli to ~6KB.
// ModelDef JSON is extremely repetitive, so the ratio is ~57x; gzip only
// manages ~23x, and the difference is thousands of tokens of an agent's
// context, so brotli it is. Both are node:zlib builtins — this module adds no
// dependency, which is the point of the client that consumes it.
//
// This module is also the ONE place in the engine that touches Malloy's
// semi-internal (underscore) surface — extractModelDef / rehydrateModel — so a
// malloy upgrade that moves them breaks in exactly one file, guarded by
// test/model-blob.test.ts.

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlibConstants,
} from 'node:zlib';
import type { Model, Runtime, SingleConnectionRuntime } from '@malloydata/malloy';

/** Bump when the envelope shape changes; an old blob then fails the gate. */
export const MODEL_BLOB_FORMAT = 1;

// Malloy does not re-export MALLOY_VERSION from its index, but it DOES export
// "./package.json" in its exports map — so this resolves under plain Node ESM
// with no JSON import attributes and no bundler help.
const require = createRequire(import.meta.url);
export const MALLOY_VERSION: string =
  (require('@malloydata/malloy/package.json') as { version?: string }).version ?? 'unknown';

/**
 * The wire envelope. Deliberately flat and self-describing: a human staring at
 * one in a terminal can tell what it is, what compiled it, and what reads it.
 */
export interface ModelBlob {
  format: number;
  /** The Malloy that COMPILED the def. ModelDef shape is tied to it, so this
      is the real compatibility key — see `decodeModelBlob`. */
  malloy_version: string;
  /** The malloyyo_client release that matches this server. Reported so an
      out-of-date client is told exactly what to install, never left guessing. */
  client_version: string;
  /** The model this came from (the dataset name on a hosted instance). */
  model_ref: string;
  encoding: 'br+base64';
  /** sha256 of the raw ModelDef JSON, truncated to 16 hex chars — enough to
      catch a truncated or mangled copy/paste, which is the realistic failure
      when a blob travels through an agent's context. */
  sha256: string;
  /** Raw (pre-compression) JSON length, so tools can report a real size. */
  bytes: number;
  payload: string;
}

// ── Semi-internal Malloy APIs (underscore) — pinned by test/model-blob.test.ts ─

/** The fully-compiled, JSON-serializable ModelDef behind a compiled Model. */
export function extractModelDef(model: unknown): unknown {
  const def = (model as { _modelDef?: unknown } | null | undefined)?._modelDef;
  if (def == null) throw new Error('Model._modelDef unavailable — malloy internal API changed?');
  return def;
}

type AnyRuntime = Runtime | SingleConnectionRuntime;
type ModelMaterializer = ReturnType<Runtime['loadModel']>;

/** A runnable ModelMaterializer from a serialized ModelDef, with NO recompile
    and — crucially for the client — no schema fetch, so no driver is needed. */
export function rehydrateModel(runtime: AnyRuntime, def: unknown): ModelMaterializer {
  const fn = (runtime as unknown as Record<string, unknown>)._loadModelFromModelDef;
  if (typeof fn !== 'function') {
    throw new Error('Runtime._loadModelFromModelDef unavailable — malloy internal API changed?');
  }
  return (fn as (d: unknown) => ModelMaterializer).call(runtime, def) as ModelMaterializer;
}

// ── Encode / decode (pure) ───────────────────────────────────────────────────

function sha16(json: string): string {
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}

export interface EncodeOptions {
  model_ref: string;
  /** The malloyyo_client version that matches this build. */
  client_version: string;
}

/** Compress a compiled ModelDef into the wire envelope. */
export function encodeModelBlob(def: unknown, opts: EncodeOptions): ModelBlob {
  const json = JSON.stringify(def);
  // Quality 11 is the slow end of brotli, but this runs once per fetch against
  // a few hundred KB (tens of ms) and every byte saved is agent context.
  const payload = brotliCompressSync(Buffer.from(json), {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: json.length,
    },
  }).toString('base64');
  return {
    format: MODEL_BLOB_FORMAT,
    malloy_version: MALLOY_VERSION,
    client_version: opts.client_version,
    model_ref: opts.model_ref,
    encoding: 'br+base64',
    sha256: sha16(json),
    bytes: json.length,
    payload,
  };
}

export type DecodeResult =
  | { ok: true; def: unknown; blob: ModelBlob }
  | { ok: false; error: string };

/**
 * Decode and validate an envelope. Never throws — a bad blob is a diagnosable
 * result, because the thing handing it over may be an agent that pasted it.
 *
 * The version gate is deliberately EXACT on `malloy_version`: a ModelDef is the
 * compiler's internal shape, so reading one written by a different Malloy is
 * undefined behavior, not a warning. Failing here with the version to install
 * is what keeps client and server from silently drifting.
 */
export function decodeModelBlob(input: unknown): DecodeResult {
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input) as unknown;
    } catch {
      return { ok: false, error: 'not a model blob: input is not valid JSON.' };
    }
  }
  const blob = input as Partial<ModelBlob> | null;
  if (!blob || typeof blob !== 'object' || typeof blob.payload !== 'string') {
    return { ok: false, error: 'not a model blob: no `payload` field.' };
  }
  if (blob.format !== MODEL_BLOB_FORMAT) {
    return {
      ok: false,
      error:
        `model blob format ${String(blob.format)} — this build reads format ` +
        `${MODEL_BLOB_FORMAT}. Re-fetch the model` +
        (blob.client_version ? ` with malloyyo_client ${blob.client_version}.` : '.'),
    };
  }
  if (blob.encoding !== 'br+base64') {
    return { ok: false, error: `unsupported model blob encoding '${String(blob.encoding)}'.` };
  }
  if (blob.malloy_version !== MALLOY_VERSION) {
    return {
      ok: false,
      error:
        `this model was compiled by Malloy ${String(blob.malloy_version)}, but this ` +
        `build bundles Malloy ${MALLOY_VERSION}. A compiled model can only be read ` +
        `by the Malloy that wrote it.` +
        (blob.client_version
          ? `\nInstall the matching client:  npm i -g @malloydata/malloyyo-client@${blob.client_version}`
          : ''),
    };
  }
  let json: string;
  try {
    json = brotliDecompressSync(Buffer.from(blob.payload, 'base64')).toString('utf8');
  } catch {
    return { ok: false, error: 'model blob payload is corrupt (brotli decompress failed) — re-fetch it.' };
  }
  if (typeof blob.sha256 === 'string' && sha16(json) !== blob.sha256) {
    return {
      ok: false,
      error: 'model blob checksum mismatch — the payload was truncated or altered in transit. Re-fetch it.',
    };
  }
  try {
    return { ok: true, def: JSON.parse(json) as unknown, blob: blob as ModelBlob };
  } catch {
    return { ok: false, error: 'model blob payload did not contain valid JSON — re-fetch it.' };
  }
}

// ── Connection introspection ─────────────────────────────────────────────────

/**
 * Every (connection name → dialect) pair the compiled model references.
 *
 * The client needs this to stand up stub connections: a Runtime resolves a
 * source's connection by NAME and asks it for a dialect, and a model can mix
 * dialects (a BigQuery source joined to a DuckDB one), so a single hardcoded
 * stub would compile the wrong SQL for the second connection. Walking the def
 * keeps that map derived from the model itself rather than carried alongside it
 * where it could go stale.
 */
export function modelConnections(def: unknown): Map<string, string> {
  const pairs = new Map<string, string>();
  const seen = new Set<unknown>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const v of node) walk(v);
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return; // structdefs are shared/repeated across the tree
    seen.add(node);
    const o = node as { connection?: unknown; dialect?: unknown };
    if (typeof o.connection === 'string' && typeof o.dialect === 'string') {
      // First writer wins: a connection has one dialect, and re-setting it on
      // every repeat would just churn.
      if (!pairs.has(o.connection)) pairs.set(o.connection, o.dialect);
    }
    for (const v of Object.values(node as Record<string, unknown>)) walk(v);
  };
  walk(def);
  return pairs;
}

/** Exposed for tests: what this build stamps onto, and demands of, a blob. */
export const _blobMeta = { MODEL_BLOB_FORMAT, MALLOY_VERSION };

/** A compiled Model, narrowed to what `extractModelDef` needs. */
export type CompiledModel = Model;
