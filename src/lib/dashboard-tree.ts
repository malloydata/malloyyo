// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The implementation is in @malloyyo/mcp-engine: the CLI renders the same tree
// into `dashboard dev` and every static bundle, and one filter means one answer
// to "what does this search match". Re-exported so server imports are unchanged.
export { filterTree, type TreeDashboard, type TreeDataset } from "@malloyyo/mcp-engine";
