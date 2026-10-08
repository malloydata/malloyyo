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
  AccessModifier,
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
  ExploreDescribedPath,
  JoinOutline,
  DescribedView,
  ExploreSourceInfo,
  ExploreView,
  JoinEntry,
  FieldGroups,
  FieldInfo,
  GivenInfo,
  HelpTopic,
  HostOnly,
  JoinInfo,
  DashboardEntry,
  ListedDashboard,
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
export {
  projectModel, projectDescription, buildSourceDescribe,
  describeSourceOutline, describeSourcePath, type PathDescribe,
  publicGroups, publicSource, publicOnlyModel,
} from './project';
export {
  modelCatalogEntry,
  catalogDocWarnings,
  SOURCE_DESCRIPTION_CHARS,
  MODEL_DESCRIPTION_CHARS,
} from './catalog';
export { run, executeMaterialized, DEFAULT_ROW_LIMIT, type RunOptions } from './run';
export { rowLimitTruncation } from './truncation';
export { jsonRows } from './rows';
export { validateRestricted, runRestricted } from './restricted';
export {
  datasetTitle,
  readDatasetMeta,
  titleFromName,
  type DatasetMeta,
} from './dataset-meta';
export { filterTree, type TreeDashboard, type TreeDataset } from './dashboard-tree';
export {
  ArchiveURLReader,
  archiveLister,
  keepsFile,
  KEEP_EXTENSIONS,
  archiveEntries,
  buildTarGz,
  extractTarGz,
  type Tarball,
} from './tarball';
export {
  DATASETS_DIR,
  ENTRY_FILE,
  layoutFromListing,
  nameToSlug,
  repoPath,
  type DirEntry,
  type DirLister,
  type DiscoveredDataset,
  type RepoLayout,
} from './repo-layout';
export {
  declaredGivenNames,
  unreferencedGivens,
  unreferencedGivensMessage,
  withoutReservedGivens,
  RESERVED_GIVEN_PREFIX,
  type RequiredGivens,
} from './host-givens';
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

// Prompt surfaces — the typed tree over the text in content/prompts/**.md
// (tool titles/descriptions + server instructions).
export { prompts } from './prompts';
