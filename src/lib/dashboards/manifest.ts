// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

import type { ArtifactInfo } from "@malloyyo/mcp-engine";

/**
 * The stored manifest for a structure-v2 dashboard read from
 * `dashboards/<base>.malloy`: `entryFile` (so the server runs it against its
 * own file) plus `tiles` or `query`, and the tag's presentation settings.
 * Shared by the GitHub refresh and scratch dashboards so the two can't drift
 * from each other — or from what the CLI publish path sends.
 */
export function artifactManifest(base: string, a: ArtifactInfo): Record<string, unknown> {
  const manifest: Record<string, unknown> = { title: a.title, entryFile: `dashboards/${base}.malloy` };
  if (a.tiles) manifest.tiles = a.tiles;
  // Single-query artifact (no tiles): persist its run-expression — the app
  // needs manifest.query to run/introspect it.
  else if (a.query) manifest.query = a.query;
  if (a.dashboard_columns !== undefined) manifest.dashboard_columns = a.dashboard_columns;
  if (a.description) manifest.description = a.description;
  if (a.givens) manifest.givens = a.givens;
  if (a.autorun === false) manifest.autorun = false;
  return manifest;
}
