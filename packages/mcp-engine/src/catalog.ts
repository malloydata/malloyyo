// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// Catalog projection: a compiled model → its `list_sources` entry. ONE
// definition, shared by every ExploreHost.list() (the CLI host, the hosted
// host, the test host). A host owns "which models can this principal see" and
// how to compile one; the SHAPE of a catalog entry is the surface's business,
// so it lives here — never re-derived per host (that drift is the whole reason
// this exists).

import type { ModelEntry, ModelInfo, SourceEntry, SourceInfo } from './types';

function sourceEntryOf(s: SourceInfo): SourceEntry {
  const e: SourceEntry = { source_ref: s.name };
  if (s.description) e.description = s.description;
  if (s.instructions) e.instructions = s.instructions;
  if (s.mustQuote) e.mustQuote = true;
  return e;
}

/**
 * The catalog entry for one model: its exported sources, each carrying the
 * annotations a caller picks from. Pass a model compiled with `exportedOnly`
 * so only the public surface is listed. Named queries are intentionally omitted
 * (their dual run/source nature isn't designed yet).
 *
 * Model-level metadata a host owns out-of-band (a human-set dataset
 * description, say) is the host's to set on the returned entry afterwards —
 * the engine only knows what the compiled model carries.
 */
export function modelCatalogEntry(model_ref: string, model: ModelInfo): ModelEntry {
  const entry: ModelEntry = { model_ref };
  const sources = Object.values(model.sources).map(sourceEntryOf);
  if (sources.length) entry.sources = sources;
  return entry;
}
