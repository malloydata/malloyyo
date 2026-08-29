// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The dataset's written front door: `dashboards/index.jsx|tsx` in the model repo,
// with no `index.malloy` beside it.
//
// It is a dashboard in every way that matters — repo-authored React, rendered by
// the same runtime, in the same sandbox — except that it runs NO QUERY. That is
// the whole point: it is prose about the data, its scope and its origins, which
// is exactly the thing a reader needs before any chart means anything.
//
// It used to exist only in `malloyyo dashboard bundle`, which special-cased the
// filename. `publish` never uploaded it and the GitHub refresh never fetched it,
// so a hosted dataset had no introduction even when its repo shipped one.
//
// Kept in one module because four call sites need the same two facts — what it
// is called, and how to recognise one — and disagreeing about either would put a
// page in the nav that no route can render.

/** The artifact name. Matches the file it comes from (`index.jsx`) and the
    `index.html` the static bundle already emits for it. */
export const ABOUT_NAME = "index";

/** What a reader sees in the nav. There is no `.malloy`, so there is no
    `## artifact { title= }` to carry an author's own title — a repo that wants
    one adds `dashboards/index.malloy`, which makes it an ordinary dashboard. */
export const ABOUT_TITLE = "About";

/**
 * Does this dashboard render no data?
 *
 * A manifest with neither `query` nor `tiles` has nothing to run. Callers use it
 * to skip given introspection and model compilation — both of which need a query
 * that by definition isn't there, and which would otherwise report its absence
 * as a "model error" printed over the page the author wrote.
 *
 * Written against the manifest rather than the name so it stays true for any
 * future queryless page, not just the one called "index".
 */
export function rendersNoData(manifest: Record<string, unknown>): boolean {
  const tiles = manifest.tiles;
  const hasTiles = Array.isArray(tiles) && tiles.length > 0;
  const hasQuery = typeof manifest.query === "string" && manifest.query !== "";
  return !hasTiles && !hasQuery;
}

/**
 * The About page first, everything else in the order given.
 *
 * This sort IS the front door: the dataset switcher and the home page both link
 * to a dataset's FIRST dashboard, so putting About at the head is what makes
 * "switch datasets and land on the introduction" true. Relying on the name sort
 * would work only by accident — "index" happens to precede the dashboards these
 * repos ship, and a dashboard named "a…" would silently take the slot.
 *
 * Stable for everything else (Array#sort is stable), so the caller's ordering —
 * alphabetical by name — survives underneath.
 */
export function aboutFirst<T extends { name: string }>(rows: T[]): T[] {
  return rows.sort((a, b) => Number(b.name === ABOUT_NAME) - Number(a.name === ABOUT_NAME));
}
