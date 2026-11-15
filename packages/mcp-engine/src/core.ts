// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The engine's core: what any Malloy host can use. It holds none of malloyyo's
// product logic (datasets, repos, publishing, dashboard rendering); dashboards
// appear only as optional, host-supplied fields of the wire types. Its help is
// the Malloy topics; a host adds its own with addHelpContent. Everything here
// is a pure function over an injected `malloy.Runtime` or the wire types, and
// it bundles with esbuild's `platform: 'neutral'` (test/core.test.ts), so a
// host that runs JavaScript outside Node can use it: the malloy-duckdb
// extension runs it in QuickJS. The full entry (./index) is this plus
// malloyyo's layers; both share one copy of the help index (scripts/build.mjs
// splits shared code into chunks).

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
export {
  addHelpContent,
  listHelpTopics,
  getHelpTopic,
  helpTopicForCode,
  engineSkills,
} from './help';
export { guidance, assembleInstructions } from './guidance';
export { prompts } from './prompts';

export {
  toContent,
  mergeSurfaces,
  yoHelpTool,
  DEFAULT_RESULT_BYTES,
  type ResultPolicy,
  type SpillContext,
  type ToolDef,
  type ToolSurface,
} from './surfaces/shared';
export { applyResultBudget, fitsDescribeBudget } from './surfaces/budget';
export {
  exploreSurface,
  type BoundModel,
  type ExploreHost,
  type ExploreSurfaceOptions,
} from './surfaces/explore';
