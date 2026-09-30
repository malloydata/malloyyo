// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The implementation is in @malloyyo/mcp-engine, because the CLI packs the same
// archive this server extracts and one format needs one implementation. Re-
// exported here so server imports read like every other lib module.
export {
  ArchiveURLReader,
  archiveDir,
  archiveEntries,
  buildTarGz,
  extractTarGz,
  type Tarball,
} from "@malloyyo/mcp-engine";
