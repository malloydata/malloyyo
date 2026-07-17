// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// @malloyyo/mcp-engine — vendor-neutral Malloy MCP engine.
// Three layers (see docs/mcp-engine.md in the repo root):
//   1. types    — the wire contract every surface imports
//   2. helpers  — pure functions over an injected malloy.Runtime
//   3. turnkey  — ready-made develop/explore tool surfaces (tools as data)
// Hosts own: Runtime construction, connection lifecycle, bindings,
// identity/auth, and transport. (The MCP SDK adapter is the separate
// './mcp-sdk' subpath export so the SDK stays an optional peer.)

// Layer 1 — types
export type {
  Annotation,
  ArrayStub,
  CompactField,
  CompactMember,
  CompactSchema,
  CompactType,
  CompileResult,
  DescribeResult,
  ExploreDescribedSource,
  ExploreDescription,
  ExploreField,
  ExploreFieldGroups,
  ExploreJoin,
  ExploreModelInfo,
  ExploreSourceDescribe,
  ExploreSourceInfo,
  ExploreView,
  JoinEntry,
  FieldGroups,
  FieldInfo,
  GivenInfo,
  HelpTopic,
  HostOnly,
  JoinInfo,
  ListedModel,
  ListedSource,
  ListSourcesResult,
  Loc,
  ModelEntry,
  ModelInfo,
  ModelList,
  NamedQueryInfo,
  Problem,
  QueryValidationResult,
  RunResult,
  RunStatementInfo,
  SourceDescribeResult,
  SourceDescription,
  SourceEntry,
  SourceInfo,
  Surface,
  TruncationInfo,
  ViewInfo,
  WithHostOnly,
} from './types';
export { HOST_ONLY } from './types';

// Layer 2 — helpers
export { compile, listRuns, type CompileOptions, type RunListing } from './walker';
export { selectSource, describeSource } from './select';
export { projectModel, projectDescription, buildSourceDescribe } from './project';
export { modelCatalogEntry } from './catalog';
export { run, executeMaterialized, DEFAULT_ROW_LIMIT, type RunOptions } from './run';
export { validateRestricted, runRestricted } from './restricted';
export {
  dashboardGivenSpecs,
  describeGivenSpec,
  type DashboardGivenSpec,
  type DashboardGivenSpecsResult,
} from './given-specs';
export {
  artifactQueries,
  collectDrillTargets,
  modelArtifact,
  readArtifactTag,
  type ArtifactInfo,
  type ArtifactsResult,
} from './artifacts';
export {
  combineTiles,
  type CombinableResult,
  type CombineOptions,
  type DashboardTile,
} from './combine-tiles';
export {
  listHelpTopics,
  getHelpTopic,
  helpTopicForCode,
  engineSkills,
} from './help';
export { prettify, type PrettifyOutcome } from './prettify';
export { INSTANCE_PLACEHOLDER, renderInstructions } from './instance';
export {
  mapProblems,
  errorProblem,
  codeProblem,
  hasError,
  gateConfigProblems,
} from './problems';
export { prepareSource, type PreparedSource, type SourceInput } from './prepare-source';

// Layer 3 — turnkey surfaces
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
export {
  exploreSurface,
  queryTool,
  type BoundModel,
  type ExploreHost,
  type ExploreSurfaceOptions,
  type InspectHint,
  type QueryToolOptions,
} from './surfaces/explore';
export {
  developSurface,
  type DevelopHost,
  type DevelopSurfaceOptions,
} from './surfaces/develop';
export { applyResultBudget, fitsDescribeBudget } from './surfaces/budget';

// Guidance — the free service (canon blocks for custom layer-2 surfaces)
export { guidance, assembleInstructions } from './guidance';

// Model-contributed guidance (guidance/**.md in the model repo → yo_help topics)
export {
  modelGuidanceTopics,
  guidanceInstructionsBlock,
  type GuidanceTopic,
} from './model-guidance';

// Raw-query escape hatch (model-author opt-in) + its read-only SQL gate
export { checkSelectOnly } from './sql-guard';
export {
  rawQueryTool,
  RAW_QUERY_DEFAULT_ROWS,
  RAW_QUERY_MAX_ROWS,
  type RawQueryHost,
  type RawQueryRows,
} from './surfaces/raw-query';

// Prompt surfaces — the typed tree over the text in content/prompts/**.md
// (tool titles/descriptions + server instructions).
export { prompts } from './prompts';
