// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

// The malloyyo version reported by the running server — in the MCP `initialize`
// handshake (serverInfo.version) and at /api/version. Single source of truth is
// this repo's root package.json (@malloyyo/server). The release script keeps
// that version in lockstep with the published CLI (@malloydata/malloyyo) — the
// CLI and the server are two faces of the same repo, so they share one version.
// (The mcp-engine is an internal, unpublished library pinned at 0.0.1 and is
// deliberately NOT the version anyone means.)
//
// Importing the manifest keeps this honest: cut a release, and everything the
// server reports follows automatically — no hand-edited literal to drift.
import { version } from "../../package.json";

export const VERSION: string = version;
