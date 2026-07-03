// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Durable compiled-ModelDef cache (L2). Stores gzip(JSON(envelope)) — where the
// envelope wraps Model._modelDef — in malloy_models.compiled_model_def, so a cold
// serverless instance can rehydrate a fully-compiled model instead of paying the
// per-source schema-fetch compile. Keyed by the immutable model.id, so it never
// needs invalidation: a repo edit is a new row with a null column.
//
// This module is the ONE place that touches Malloy's semi-internal (underscore)
// surface — extractModelDef / rehydrateModel — so a malloy upgrade that changes
// the shape breaks in exactly one file, guarded by model-cache.test.ts.

import { gzipSync, gunzipSync } from "node:zlib";
import type * as malloy from "@malloydata/malloy";
import malloyPkg from "@malloydata/malloy/package.json";

// On-disk envelope. Bump CACHE_FORMAT if this shape changes. The malloy version
// is stored so a /malloy-update whose ModelDef shape changed is self-healing: an
// old-version blob unpacks to `undefined` (a miss) and is recompiled + overwritten.
const CACHE_FORMAT = 1;
const MALLOY_VERSION: string = (malloyPkg as { version?: string }).version ?? "unknown";

type AnyRuntime = malloy.Runtime | malloy.SingleConnectionRuntime;
type ModelMaterializer = ReturnType<malloy.Runtime["loadModel"]>;

// ── Semi-internal Malloy APIs (underscore) — pinned by model-cache.test.ts ────

/** The fully-compiled, JSON-serializable ModelDef for a compiled Model. */
export function extractModelDef(model: unknown): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def = (model as any)?._modelDef;
  if (def == null) throw new Error("Model._modelDef unavailable — malloy internal API changed?");
  return def;
}

/** A runnable ModelMaterializer from a serialized ModelDef, with NO recompile. */
export function rehydrateModel(runtime: AnyRuntime, def: unknown): ModelMaterializer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = (runtime as any)?._loadModelFromModelDef;
  if (typeof fn !== "function") throw new Error("Runtime._loadModelFromModelDef unavailable — malloy internal API changed?");
  return fn.call(runtime, def) as ModelMaterializer;
}

// ── Pack / unpack (pure) ──────────────────────────────────────────────────────

export function packModelDef(def: unknown): Buffer {
  return gzipSync(Buffer.from(JSON.stringify({ f: CACHE_FORMAT, m: MALLOY_VERSION, def })));
}

/**
 * Unpack a stored blob. Returns `undefined` (a cache miss, forcing recompile) if
 * the blob is corrupt, or was written by a different cache format / malloy version.
 */
export function unpackModelDef(packed: Buffer | Uint8Array): unknown | undefined {
  try {
    const env = JSON.parse(gunzipSync(packed).toString("utf8")) as { f?: number; m?: string; def?: unknown };
    if (env.f !== CACHE_FORMAT || env.m !== MALLOY_VERSION) return undefined;
    return env.def;
  } catch {
    return undefined;
  }
}

// ── L2 storage (Postgres). db imported lazily so this module stays importable
//    (and unit-testable) without DATABASE_URL. ───────────────────────────────

export async function readModelDef(modelId: string): Promise<Buffer | null> {
  const { db, malloyModels } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const [row] = await db
    .select({ def: malloyModels.compiledModelDef })
    .from(malloyModels)
    .where(eq(malloyModels.id, modelId))
    .limit(1);
  return row?.def ?? null;
}

export async function writeModelDef(modelId: string, packed: Buffer): Promise<void> {
  const { db, malloyModels } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  await db.update(malloyModels).set({ compiledModelDef: packed }).where(eq(malloyModels.id, modelId));
}

/** Exposed for tests: the version this build stamps onto stored defs. */
export const _cacheMeta = { CACHE_FORMAT, MALLOY_VERSION };
