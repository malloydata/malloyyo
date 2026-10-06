// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

/**
 * What a dataset is CALLED, as against what it IS.
 *
 * A dataset's identity is its directory: `datasets/hub_spot/` publishes
 * `hub_spot`, which is the URL, what a publish matches on, and what an admin
 * grants a role against. That name has to be a slug, so it cannot also be the
 * label — "hub_spot" is not what anyone wants to read in a menu.
 *
 * So a dataset carries a title the same way a dashboard does
 * (`# artifact { title= }`), declared at model scope in its `index.malloy`:
 *
 *     ##" Deals, contacts and companies, as the sales team sees them.
 *     ## dataset { title="HubSpot CRM" }
 *
 * With no tag the title is DERIVED from the name, so every dataset that exists
 * today reads better without being touched. The tag is for when the mechanical
 * version is wrong — an acronym, a product's own capitalisation, a year.
 *
 * In the engine because both sides need the same answer: the server stores and
 * renders it, and `malloyyo lint` tells an author what their dataset will be
 * called before they publish it.
 */

interface TagLike {
  has(key: string): boolean;
  text(...path: string[]): string | undefined;
  tag(key: string): TagLike | undefined;
}
interface Tagged {
  annotations: {
    parseAsTag(): { tag: TagLike };
    forRoute(route: string): { content: string }[];
  };
}

export interface DatasetMeta {
  /** `## dataset { title= }`, when the model declares one. */
  title?: string;
  /**
   * The model's own doc string — `##"`, two hashes.
   *
   * `#"` attaches to whatever DECLARATION follows it, so a `#"` above the first
   * source documents that source and leaves the model with nothing. `##"` is the
   * model's.
   */
  description?: string;
}

/**
 * A readable title from a dataset name.
 *
 * `hub_spot` → "Hub Spot". Mechanical, so it is right for most names and wrong
 * for some — "imdb" becomes "Imdb" — which is exactly what the tag is for.
 */
export function titleFromName(name: string): string {
  return name
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** The title to show: the declared one, else derived from the name. */
export function datasetTitle(name: string, declared?: string | null): string {
  const t = declared?.trim();
  return t || titleFromName(name);
}

/**
 * Read `## dataset { … }` and the model's doc string from a compiled model.
 *
 * Only the ENTRY file's model annotations are visible, and they do not cross
 * imports — so a shared `lib/` cannot title the datasets that import it.
 */
export function readDatasetMeta(model: unknown): DatasetMeta {
  const m = model as Tagged;
  let title: string | undefined;
  try {
    const tag = m.annotations.parseAsTag().tag;
    if (tag.has("dataset")) {
      title = tag.tag("dataset")?.text("title") ?? tag.text("title");
    }
  } catch {
    // An unparseable annotation is not a reason to fail a compile that worked.
  }
  let description: string | undefined;
  try {
    const docs = m.annotations
      .forRoute('"')
      .map((n) => n.content.trim())
      .filter(Boolean);
    if (docs.length) description = docs.join("\n");
  } catch {
    // Same reasoning as the tag: a doc string we cannot read is not a failure.
  }
  return { ...(title ? { title } : {}), ...(description ? { description } : {}) };
}
