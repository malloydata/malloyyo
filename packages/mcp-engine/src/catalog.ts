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
  if (s.must_quote) e.must_quote = true;
  return e;
}

/**
 * The catalog entry for one model: its exported sources, each carrying the
 * annotations a caller picks from. Pass a model compiled with `exportedOnly`
 * so only the public surface is listed. Named queries are intentionally omitted
 * (their dual run/source nature isn't designed yet).
 *
 * Descriptions only: a source's `#(agent)` instructions belong to
 * describe_source. The listing is read before anyone knows which source they
 * want, so it carries what it takes to choose one and no more — that is what
 * keeps a catalog of well-documented sources small.
 */
export function modelCatalogEntry(model_ref: string, model: ModelInfo): ModelEntry {
  const entry: ModelEntry = { model_ref };
  if (model.description) entry.description = model.description;
  const sources = Object.values(model.sources).map(sourceEntryOf);
  if (sources.length) entry.sources = sources;
  return entry;
}

// ── what an author should hear about it ─────────────────────────────────────
//
// `list_sources` is read before anyone knows which source they want, so every
// description in it is paid for on every question. These are the sizes the
// authoring help (`yo_help("develop/documenting-models")`) asks for; lint warns
// past them. Warnings, never errors: a long description works, it just costs.

/** A source's `#"`: one sentence on what it answers. */
export const SOURCE_DESCRIPTION_CHARS = 300;
/** The model's `##"`: a sentence or two on what the dataset is. */
export const MODEL_DESCRIPTION_CHARS = 500;

/** Lint findings for a model's catalog entry — the listing as the server will
    show it. Pass the entry modelCatalogEntry built from an `exportedOnly`
    compile. */
export function catalogDocWarnings(entry: ModelEntry): string[] {
  const out: string[] = [];
  const help = 'see yo_help("develop/documenting-models")';
  if (!entry.description) {
    out.push(
      `the model has no ##" description — list_sources shows nothing for what this dataset is (${help})`,
    );
  } else if (entry.description.length > MODEL_DESCRIPTION_CHARS) {
    out.push(
      `the model's ##" is ${entry.description.length} characters; keep it to a sentence or two ` +
        `(under ${MODEL_DESCRIPTION_CHARS}) — list_sources shows it on every question (${help})`,
    );
  }
  for (const s of entry.sources ?? []) {
    if (!s.description) {
      out.push(
        `source '${s.source_ref}' has no #" description — list_sources is how a reader picks a source (${help})`,
      );
    } else if (s.description.length > SOURCE_DESCRIPTION_CHARS) {
      out.push(
        `source '${s.source_ref}': its #" is ${s.description.length} characters; keep it to one sentence on ` +
          `what the source answers (under ${SOURCE_DESCRIPTION_CHARS}) and move usage guidance to #(agent), ` +
          `which describe_source shows (${help})`,
      );
    }
  }
  return out;
}
