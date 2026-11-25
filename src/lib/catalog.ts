// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// A model version's catalog entry: what `list_sources` shows for it. It depends
// only on the version, never on who asks, so it is computed once, at publish,
// and stored in malloy_models.catalog. Listing reads it and never compiles.
//
// Both halves go through the engine's own projection (modelCatalogEntry over an
// `exportedOnly` compile), so the hosted listing cannot drift from the CLI's.

import { compile, modelCatalogEntry, type ModelEntry } from "@malloyyo/mcp-engine";
import type { StoredCatalog } from "@/db";

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
  const { model_ref: _ref, ...stored } = modelCatalogEntry("", compiled.model);
  return stored;
}

/** The listing entry for a dataset, from its version's stored catalog. */
export function catalogEntry(modelRef: string, stored: StoredCatalog | null): ModelEntry {
  return { model_ref: modelRef, ...(stored ?? {}) };
}
