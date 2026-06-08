// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// `tool_calls.tool_name` is a historical LOG label, deliberately decoupled from
// the live MCP tool registry. When a tool is renamed we add the old label here
// instead of rewriting history with a data migration — history stays truthful
// and future renames are a one-line edit, never a migration.
//
// RUN_LABELS = every label that represents an *executed* query run. The history
// list and share-link resolution filter on this set, so old `run_query` rows
// and new `query` rows both surface.
export const RUN_LABELS = ["query", "run_query"] as const;
