// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The engine's core: what any Malloy host can use, with no knowledge of
// malloyyo's datasets, repos, publishing or dashboards, and only the Malloy
// help topics (a host adds its own with addHelpContent). Everything here is a
// pure function over an injected `malloy.Runtime` or the wire types, and it
// bundles with esbuild's `platform: 'neutral'` (test/core.test.ts), so a host
// that runs JavaScript outside Node can use it: the malloy-duckdb extension
// runs it in QuickJS. The full entry (./index) is this plus malloyyo's layers.

export type * from './types';
export { HOST_ONLY } from './types';

export { compile, listRuns, type CompileOptions, type RunListing } from './walker';
export { selectSource, describeSource } from './select';
export {
  projectModel, projectDescription, buildSourceDescribe,
  publicGroups, publicSource, publicOnlyModel,
} from './project';
export { modelCatalogEntry } from './catalog';
export { run, executeMaterialized, DEFAULT_ROW_LIMIT, type RunOptions } from './run';
export { rowLimitTruncation } from './truncation';
export { jsonRows, resultColumns } from './rows';
export { validateRestricted, runRestricted } from './restricted';
export { prettify, type PrettifyOutcome } from './prettify';
export { mapProblems, errorProblem, codeProblem, hasError } from './problems';
export { addHelpContent, listHelpTopics, getHelpTopic } from './help';

export {
  toContent,
  type ToolDef,
  type ToolSurface,
} from './surfaces/shared';
export {
  exploreSurface,
  type BoundModel,
  type ExploreHost,
  type ExploreSurfaceOptions,
} from './surfaces/explore';
