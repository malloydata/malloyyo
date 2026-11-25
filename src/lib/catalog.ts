// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// A model version's catalog entry: what `list_sources` shows for it. It depends
// only on the version, never on who asks, so it is computed once, at publish,
// and stored in malloy_models.catalog. Listing reads it and never compiles.
//
// Both halves go through the engine's own projection (modelCatalogEntry over an
// `exportedOnly` compile), so the hosted listing cannot drift from the CLI's —
// and CATALOG_VERSION is what keeps a stored row from drifting from the engine:
// bump it whenever modelCatalogEntry's output changes, and every stored entry
// older than it is recomputed on its next listing (isStale).

import { compile, modelCatalogEntry, type ModelEntry } from "@malloyyo/mcp-engine";
import type { StoredCatalog } from "@/db";

/** The projection a stored catalog was made with. Bump when modelCatalogEntry changes. */
export const CATALOG_VERSION = 1;

type EngineRuntime = Parameters<typeof compile>[0];

/**
 * Compile `entry` on `runtime` and project it to a stored catalog. Null when the
 * model does not compile: the caller lists it as a bare ref, as before.
 *
 * `runtime` is typed loosely on purpose: the app and the engine resolve
 * separate copies of @malloydata/malloy, with identical declarations, and the
 * cast bridges them (the same seam as mcp-host.ts).
 */
export async function computeCatalog(runtime: unknown, entry: URL): Promise<StoredCatalog | null> {
  const compiled = await compile(runtime as EngineRuntime, entry, { exportedOnly: true });
  if (!compiled.ok || !compiled.model) return null;
  const { model_ref: _ref, ...entryFields } = modelCatalogEntry("", compiled.model);
  return { v: CATALOG_VERSION, ...entryFields };
}

/** Null, or made by an older projection than this server's: recompute it. */
export function isStale(stored: StoredCatalog | null): boolean {
  return stored === null || (stored.v ?? 0) < CATALOG_VERSION;
}

/** The listing entry for a dataset, from its version's stored catalog. */
export function catalogEntry(modelRef: string, stored: StoredCatalog | null): ModelEntry {
  if (!stored) return { model_ref: modelRef };
  const { v: _v, ...fields } = stored;
  return { model_ref: modelRef, ...fields };
}

/**
 * Recomputes stale catalogs during a listing without letting that cost repeat:
 *
 * - ONE compile per version at a time. Concurrent listings — a dashboard's
 *   tiles each run the query guard — share the compile in flight instead of
 *   each starting their own.
 * - A version that fails is not tried again until `retryMs` has passed.
 *   Without this, one model that does not compile (or whose warehouse is down,
 *   and so takes a connect timeout to fail) would be recompiled, and waited on,
 *   by every list_sources, describe_source and query until it was fixed.
 */
export class CatalogBackfill {
  private inFlight = new Map<string, Promise<StoredCatalog | null>>();
  private failedAt = new Map<string, number>();

  constructor(private readonly opts: { retryMs: number; now?: () => number }) {}

  /** False while a failure of `id` is more recent than retryMs. */
  due(id: string): boolean {
    const failed = this.failedAt.get(id);
    return failed === undefined || this.now() - failed >= this.opts.retryMs;
  }

  /**
   * Run `compute` for `id`, or join the run already in flight. Null (from
   * `compute`, or a throw) is recorded as a failure; anything else clears it.
   */
  run(id: string, compute: () => Promise<StoredCatalog | null>): Promise<StoredCatalog | null> {
    const running = this.inFlight.get(id);
    if (running) return running;
    const p = (async () => {
      let result: StoredCatalog | null = null;
      try {
        result = await compute();
      } catch {
        result = null;
      }
      if (result) this.failedAt.delete(id);
      else this.failedAt.set(id, this.now());
      return result;
    })().finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, p);
    return p;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
}
